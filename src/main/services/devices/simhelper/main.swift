// simhelper <udid> <developerDir> <quality> <maxWidth>
//
// Streams a booted simulator's lit screen and takes its input. A foldable has two: a cover screen and an inner one.
// stderr: first `ready <widthPoints> <heightPoints> <scale>`, then errors.
// stdout: frames, each a big-endian u32 length of what follows, then width u16, height u16, orientation u8
// (UIDeviceOrientation, 1 to 4), posture u8 (0 not foldable, 1 closed, 2 half open, 3 flat), the screen's
// portrait width and height in points u16 each, the inner screen's the same way (0 when not foldable), then a JPEG
// already rotated to what the screen shows.
// stdin, one command per line, fractions of the screen as shown:
//   touch down|move|up <fx> <fy>, key <usage> down|up, consumer <usage> down|up, rotate <1-4>, hinge <degrees>
import CoreImage
import Foundation
import IOSurface
import ImageIO

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 5, let quality = Double(arguments[3]), let maxWidth = Double(arguments[4]) else {
  fail("usage: simhelper <udid> <developerDir> <quality> <maxWidth>")
}
let udid = arguments[1]
let developerDir = arguments[2]

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil else {
  fail("cannot load CoreSimulator")
}

let deviceStateBooted = 3

func findDevice() -> NSObject {
  guard let contextClass = NSClassFromString("SimServiceContext") as AnyObject?,
    let context = contextClass.perform(
      NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"), with: developerDir, with: nil)?
      .takeUnretainedValue(),
    let set = context.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?.takeUnretainedValue(),
    let devices = set.value(forKey: "devices") as? [NSObject]
  else { fail("cannot read the simulator device set") }
  guard let device = devices.first(where: { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }) else {
    fail("no simulator \(udid)")
  }
  return device
}

func isBooted(_ device: NSObject) -> Bool {
  (device.value(forKey: "state") as? NSNumber)?.intValue == deviceStateBooted
}

/// SimDisplayDescriptorState.displayClass returns a scalar, so it needs a typed objc_msgSend. Class 0 is the main display.
func displayClass(_ descriptor: NSObject) -> Int {
  guard let state = descriptor.perform(NSSelectorFromString("state"))?.takeUnretainedValue() as? NSObject else { return -1 }
  let selector = NSSelectorFromString("displayClass")
  guard state.responds(to: selector), let imp = state.method(for: selector) else { return -1 }
  typealias DisplayClass = @convention(c) (AnyObject, Selector) -> UInt16
  return Int(unsafeBitCast(imp, to: DisplayClass.self)(state, selector))
}

func framebufferSurface(_ descriptor: NSObject) -> IOSurfaceRef? {
  guard let surface = descriptor.perform(NSSelectorFromString("framebufferSurface"))?.takeUnretainedValue() else {
    return nil
  }
  return unsafeBitCast(surface, to: IOSurfaceRef.self)
}

/// One of the device's integrated screens: its framebuffer and what the device profile says about it.
final class Screen {
  let descriptor: NSObject
  /// The digitizer `dtuhidd` routes a touch to: 0 for the main screen, else the screen's `screenID`.
  let target: UInt64
  /// Quarter turns clockwise that show the framebuffer upright, from the profile's `nativeRotation`.
  let turns: Int
  /// Before rotation.
  let points: CGSize
  let scale: Double
  var surface: IOSurfaceRef?

  init(descriptor: NSObject, target: UInt64, turns: Int, points: CGSize, scale: Double) {
    self.descriptor = descriptor
    self.target = target
    self.turns = turns
    self.points = points
    self.scale = scale
    surface = framebufferSurface(descriptor)
  }
}

/// The integrated screens, main first. Framebuffers are matched to the profile's `displays` by pixel size;
/// without a match the device type's main screen size stands in, as for any device with one screen.
func integratedScreens(_ device: NSObject) -> [Screen] {
  let deviceType = device.value(forKey: "deviceType") as? NSObject
  let capabilities = (deviceType?.value(forKey: "capabilities") as? [String: Any])?["capabilities"] as? [String: Any]
  let profile = (capabilities?["displays"] as? [[String: Any]] ?? [])
    .filter { $0["displayType"] as? String == "integrated" }
    .sorted { ($0["screenID"] as? Int ?? 0) < ($1["screenID"] as? Int ?? 0) }
  let mainID = profile.first?["screenID"] as? Int
  let ports = (device.value(forKey: "io") as? NSObject)?.value(forKey: "ioPorts") as? [NSObject] ?? []
  let descriptors = ports
    .compactMap { $0.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject }
    .filter { $0.responds(to: NSSelectorFromString("framebufferSurface")) && displayClass($0) == 0 }
  // KVC boxes the scalar and struct returns, so no typed objc_msgSend is needed here.
  guard let mainScale = (deviceType?.value(forKey: "mainScreenScale") as? NSNumber)?.doubleValue,
    let mainPixels = (deviceType?.value(forKey: "mainScreenSize") as? NSValue)?.sizeValue, mainScale > 0
  else { fail("cannot read the simulator's screen size") }
  let screens = descriptors.map { descriptor -> (Int, Screen) in
    let match = framebufferSurface(descriptor).flatMap { surface in
      profile.first {
        $0["width"] as? Int == IOSurfaceGetWidth(surface) && $0["height"] as? Int == IOSurfaceGetHeight(surface)
      }
    }
    guard let match, let id = match["screenID"] as? Int, let scale = match["scale"] as? Double, scale > 0,
      let width = match["width"] as? Double, let height = match["height"] as? Double
    else {
      let points = CGSize(width: mainPixels.width / mainScale, height: mainPixels.height / mainScale)
      return (Int.min, Screen(descriptor: descriptor, target: 0, turns: 0, points: points, scale: mainScale))
    }
    let rotation = match["nativeRotation"] as? Int ?? 0
    return (
      id,
      Screen(
        descriptor: descriptor, target: id == mainID ? 0 : UInt64(id), turns: ((360 - rotation) / 90) % 4,
        points: CGSize(width: width / scale, height: height / scale), scale: scale)
    )
  }
  guard !screens.isEmpty else { fail("the simulator has no main display") }
  return screens.sorted { $0.0 < $1.0 }.map { $0.1 }
}

let device = findDevice()
guard isBooted(device) else { fail("the simulator is not booted") }
let screens = integratedScreens(device)
let foldable = screens.count > 1

let encodeQueue = DispatchQueue(label: "encode", qos: .userInteractive)
let ci = CIContext(options: [.useSoftwareRenderer: false])
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
let out = FileHandle.standardOutput

let postureNone: UInt8 = 0
let postureClosed: UInt8 = 1
let postureHalfOpen: UInt8 = 2
let postureFlat: UInt8 = 3

/// A screen the guest has switched off keeps its last frame, which is black.
func isLit(_ surface: IOSurfaceRef) -> Bool {
  let image = CIImage(ioSurface: surface)
  let average = image.applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: CIVector(cgRect: image.extent)])
  var pixel = [UInt8](repeating: 0, count: 4)
  ci.render(
    average, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8,
    colorSpace: sRGB)
  return pixel[0..<3].contains { $0 > 2 }
}

// Read and written on encodeQueue.
var active = foldable ? (screens.first { $0.surface.map(isLit) ?? false } ?? screens[0]) : screens[0]
var posture = !foldable ? postureNone : active === screens[0] ? postureClosed : postureFlat
var orientation: UInt8 = 1
var encodePending = false

/// The device orientation as quarter turns clockwise, which add to the screen's own.
func turns(_ orientation: UInt8) -> Int {
  switch orientation {
  case 4: return 1
  case 2: return 2
  case 3: return 3
  default: return 0
  }
}

/// The framebuffer stays portrait when the device rotates, as the glass does, so frames turn the way the user holds it.
func imageOrientation(_ turns: Int) -> CGImagePropertyOrientation {
  switch turns {
  case 1: return .right
  case 2: return .down
  case 3: return .left
  default: return .up
  }
}

/// The UIDeviceOrientation a frame turned by `turns` looks like, so a landscape screen reads as landscape.
func shownOrientation(_ turns: Int) -> UInt8 {
  switch turns {
  case 1: return 4
  case 2: return 2
  case 3: return 3
  default: return 1
  }
}

func emit() {
  guard let surface = active.surface else { return }
  let shown = (active.turns + turns(orientation)) % 4
  let full = CIImage(ioSurface: surface)
  let scale = min(1, maxWidth / full.extent.width)
  let image = full.transformed(by: CGAffineTransform(scaleX: scale, y: scale)).oriented(imageOrientation(shown))
  let options = [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality]
  guard let jpeg = ci.jpegRepresentation(of: image, colorSpace: sRGB, options: options) else { return }
  var header = Data(capacity: 18)
  func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.bigEndian) { header.append(contentsOf: $0) } }
  append(UInt32(jpeg.count + 14))
  append(UInt16(image.extent.width.rounded()))
  append(UInt16(image.extent.height.rounded()))
  append(shownOrientation(shown))
  append(posture)
  append(UInt16(active.points.width.rounded()))
  append(UInt16(active.points.height.rounded()))
  append(UInt16(foldable ? screens[1].points.width.rounded() : 0))
  append(UInt16(foldable ? screens[1].points.height.rounded() : 0))
  do {
    try out.write(contentsOf: header + jpeg)
  } catch {
    exit(0)
  }
}

/// Encodes at most one frame at a time and drops the frames that land meanwhile, so a slow reader never queues stale ones.
func scheduleEmit(_ screen: Screen) {
  encodeQueue.async {
    if encodePending || screen !== active { return }
    encodePending = true
    encodeQueue.async {
      emit()
      encodePending = false
    }
  }
}

typealias RegisterScreen = @convention(c) (AnyObject, Selector, NSUUID, DispatchQueue, AnyObject, AnyObject, AnyObject) -> Void
let callbackQueue = DispatchQueue(label: "callbacks", qos: .userInteractive)
for screen in screens {
  let onFrame: @convention(block) () -> Void = { scheduleEmit(screen) }
  let onSurfaces: @convention(block) (AnyObject?, AnyObject?) -> Void = { changed, _ in
    encodeQueue.async {
      screen.surface = changed.map { unsafeBitCast($0, to: IOSurfaceRef.self) }
      if screen === active { emit() }
    }
  }
  let onProperties: @convention(block) (AnyObject?) -> Void = { _ in }
  unsafeBitCast(msgSend, to: RegisterScreen.self)(
    screen.descriptor,
    NSSelectorFromString(
      "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"),
    NSUUID(), callbackQueue, onFrame as AnyObject, onSurfaces as AnyObject, onProperties as AnyObject)
}
let hid = HID(device: device)

/// The vendor-defined connection carries the hinge, so only a foldable makes one, on its first fold.
var vendorHID: HID?

/// Maps a point on the screen as shown to its framebuffer, and names the screen's digitizer.
func framebufferPoint(_ x: Double, _ y: Double) -> (Double, Double, UInt64) {
  let (shown, target) = encodeQueue.sync { ((active.turns + turns(orientation)) % 4, active.target) }
  switch shown {
  case 1: return (y, 1 - x, target)
  case 2: return (1 - x, 1 - y, target)
  case 3: return (1 - y, x, target)
  default: return (x, y, target)
  }
}

let touchPhases: [String: UInt64] = ["down": 0, "move": 1, "up": 2]

func run(_ parts: [String]) -> Bool {
  switch (parts.first, parts.count) {
  case ("touch", 4):
    guard let x = Double(parts[2]), let y = Double(parts[3]), let phase = touchPhases[parts[1]] else { return false }
    let point = framebufferPoint(min(max(x, 0), 1), min(max(y, 0), 1))
    hid.touch(x: point.0, y: point.1, phase: phase, target: point.2)
  case ("key", 3):
    guard let usage = UInt64(parts[1]) else { return false }
    hid.key(usage: usage, down: parts[2] == "down")
  case ("consumer", 3):
    guard let usage = UInt64(parts[1]) else { return false }
    hid.consumer(usage: usage, down: parts[2] == "down")
  case ("rotate", 2):
    guard let value = UInt8(parts[1]), (1...4).contains(value) else { return false }
    hid.rotate(UInt32(value))
    encodeQueue.async {
      orientation = value
      emit()
    }
  case ("hinge", 2):
    guard foldable, let degrees = Double(parts[1]), (0...180).contains(degrees) else { return false }
    if vendorHID == nil { vendorHID = HID(device: device, service: HID.vendorDefined) }
    vendorHID?.hinge(degrees)
    encodeQueue.async {
      // The cover screen is the main one, and SpringBoard moves to the inner screen as soon as the hinge opens.
      active = degrees == 0 ? screens[0] : screens[1]
      posture = degrees == 0 ? postureClosed : degrees < 180 ? postureHalfOpen : postureFlat
      emit()
    }
  default:
    return false
  }
  return true
}

let shownAtStart = encodeQueue.sync { active }
FileHandle.standardError.write(
  "ready \(shownAtStart.points.width) \(shownAtStart.points.height) \(shownAtStart.scale)\n".data(using: .utf8)!)

Thread.detachNewThread {
  while let line = readLine() {
    let parts = line.split(separator: " ").map(String.init)
    if !run(parts) { FileHandle.standardError.write("ignored command: \(line)\n".data(using: .utf8)!) }
  }
  exit(0)
}

Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
  if !isBooted(device) { fail("the simulator shut down") }
}
RunLoop.main.run()
