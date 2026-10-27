// simhelper <udid> <developerDir> <quality> <maxWidth>
//
// Streams a booted simulator's main display and takes its input.
// stderr: first `ready <widthPoints> <heightPoints> <scale>`, then errors.
// stdout: frames, each a big-endian u32 length of what follows, then width u16, height u16 and
// orientation u8 (UIDeviceOrientation, 1 to 4), then a JPEG already rotated to what the screen shows.
// stdin, one command per line, fractions of the screen as shown:
//   touch down|move|up <fx> <fy>, key <usage> down|up, consumer <usage> down|up, rotate <1-4>
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

func mainDisplay(_ device: NSObject) -> NSObject {
  let ports = (device.value(forKey: "io") as? NSObject)?.value(forKey: "ioPorts") as? [NSObject] ?? []
  let display = ports
    .compactMap { $0.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject }
    .first { $0.responds(to: NSSelectorFromString("framebufferSurface")) && displayClass($0) == 0 }
  guard let display else { fail("the simulator has no main display") }
  return display
}

let device = findDevice()
guard isBooted(device) else { fail("the simulator is not booted") }
let display = mainDisplay(device)

// KVC boxes the scalar and struct returns, so no typed objc_msgSend is needed here.
let deviceType = device.value(forKey: "deviceType") as? NSObject
guard let screenScale = (deviceType?.value(forKey: "mainScreenScale") as? NSNumber)?.doubleValue,
  let screenPixels = (deviceType?.value(forKey: "mainScreenSize") as? NSValue)?.sizeValue, screenScale > 0
else { fail("cannot read the simulator's screen size") }
let screenPoints = CGSize(width: screenPixels.width / screenScale, height: screenPixels.height / screenScale)

let encodeQueue = DispatchQueue(label: "encode", qos: .userInteractive)
let ci = CIContext(options: [.useSoftwareRenderer: false])
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
let out = FileHandle.standardOutput
var surface: IOSurfaceRef?
var orientation: UInt8 = 1
var encodePending = false

/// The framebuffer stays portrait when the device rotates, as the glass does, so frames turn the way the user holds it.
func imageOrientation(_ orientation: UInt8) -> CGImagePropertyOrientation {
  switch orientation {
  case 2: return .down
  case 3: return .left
  case 4: return .right
  default: return .up
  }
}

func emit() {
  guard let surface else { return }
  let full = CIImage(ioSurface: surface)
  let scale = min(1, maxWidth / full.extent.width)
  let image = full.transformed(by: CGAffineTransform(scaleX: scale, y: scale)).oriented(imageOrientation(orientation))
  let options = [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality]
  guard let jpeg = ci.jpegRepresentation(of: image, colorSpace: sRGB, options: options) else { return }
  var header = Data(capacity: 9)
  withUnsafeBytes(of: UInt32(jpeg.count + 5).bigEndian) { header.append(contentsOf: $0) }
  withUnsafeBytes(of: UInt16(image.extent.width.rounded()).bigEndian) { header.append(contentsOf: $0) }
  withUnsafeBytes(of: UInt16(image.extent.height.rounded()).bigEndian) { header.append(contentsOf: $0) }
  header.append(orientation)
  do {
    try out.write(contentsOf: header + jpeg)
  } catch {
    exit(0)
  }
}

/// Encodes at most one frame at a time and drops the frames that land meanwhile, so a slow reader never queues stale ones.
func scheduleEmit() {
  encodeQueue.async {
    if encodePending { return }
    encodePending = true
    encodeQueue.async {
      emit()
      encodePending = false
    }
  }
}

let onFrame: @convention(block) () -> Void = { scheduleEmit() }
let onSurfaces: @convention(block) (AnyObject?, AnyObject?) -> Void = { changed, _ in
  encodeQueue.async {
    surface = changed.map { unsafeBitCast($0, to: IOSurfaceRef.self) }
    emit()
  }
}
let onProperties: @convention(block) (AnyObject?) -> Void = { _ in }
typealias RegisterScreen = @convention(c) (AnyObject, Selector, NSUUID, DispatchQueue, AnyObject, AnyObject, AnyObject) -> Void
unsafeBitCast(msgSend, to: RegisterScreen.self)(
  display,
  NSSelectorFromString(
    "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"),
  NSUUID(), DispatchQueue(label: "callbacks", qos: .userInteractive), onFrame as AnyObject, onSurfaces as AnyObject,
  onProperties as AnyObject)
let hid = HID(device: device)

/// Maps a point on the screen as shown to the portrait digitizer.
func portraitPoint(_ x: Double, _ y: Double) -> (Double, Double) {
  switch encodeQueue.sync(execute: { orientation }) {
  case 2: return (1 - x, 1 - y)
  case 3: return (1 - y, x)
  case 4: return (y, 1 - x)
  default: return (x, y)
  }
}

let touchPhases: [String: UInt64] = ["down": 0, "move": 1, "up": 2]

func run(_ parts: [String]) -> Bool {
  switch (parts.first, parts.count) {
  case ("touch", 4):
    guard let x = Double(parts[2]), let y = Double(parts[3]), let phase = touchPhases[parts[1]] else { return false }
    let point = portraitPoint(min(max(x, 0), 1), min(max(y, 0), 1))
    hid.touch(x: point.0, y: point.1, phase: phase)
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
  default:
    return false
  }
  return true
}

FileHandle.standardError.write(
  "ready \(screenPoints.width) \(screenPoints.height) \(screenScale)\n".data(using: .utf8)!)

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
