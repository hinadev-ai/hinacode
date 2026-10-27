import Foundation
import XPC

typealias LookupPort = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> UInt32
typealias EndpointFromPort = @convention(c) (mach_port_t, UInt64, UInt64) -> xpc_endpoint_t
typealias EnableSimToHost = @convention(c) (xpc_connection_t) -> Void

let msgSend = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend")!

func lookupPort(_ device: AnyObject, _ service: String) -> mach_port_t {
  var error: NSError?
  let port = unsafeBitCast(msgSend, to: LookupPort.self)(
    device, NSSelectorFromString("lookup:error:"), service as NSString, &error)
  guard port != 0 else { fail("\(service): \(error?.localizedDescription ?? "not found")") }
  return port
}

/// Input through dtuhidd, the guest's HID daemon. From Xcode 27 the guest drops Indigo key and button messages
/// from SimDeviceLegacyHIDClient and drops its touches now and then, so this is the path that works.
/// The XPC calls and message shapes follow facebook/idb (MIT): SimulatorXPCConnection, SimulatorDTUHIDConnection
/// and DTUHIDModels. Rotation follows its SimulatorPurpleHID.
final class HID {
  static let service = "com.apple.coredevice.feature.remote.hid.digitizer"
  let device: AnyObject
  let connection: xpc_connection_t

  init(device: AnyObject) {
    self.device = device
    let symbols = UnsafeMutableRawPointer(bitPattern: -2)
    guard let endpointFromPort = dlsym(symbols, "xpc_endpoint_create_mach_port_4sim"),
      let enableSimToHost = dlsym(symbols, "xpc_connection_enable_sim2host_4sim")
    else { fail("this macOS has no simulator XPC bridge") }
    // dtuhidd is launched on demand and can be throttled after a crash early in boot, so the first
    // connections may get no answer. A cancelled connection cannot resume, so each attempt makes a new one.
    for attempt in 1...4 {
      let endpoint = unsafeBitCast(endpointFromPort, to: EndpointFromPort.self)(lookupPort(device, HID.service), 0, 0)
      let candidate = xpc_connection_create_from_endpoint(endpoint)
      unsafeBitCast(enableSimToHost, to: EnableSimToHost.self)(candidate)
      xpc_connection_set_event_handler(candidate) { _ in }
      xpc_connection_resume(candidate)
      if HID.answers(candidate) {
        connection = candidate
        return
      }
      xpc_connection_cancel(candidate)
      if attempt < 4 { Thread.sleep(forTimeInterval: 4) }
    }
    fail("the simulator's HID service did not answer")
  }

  /// A barrier with key usage 0, "no event", so dtuhidd replies without the guest seeing a key.
  static func answers(_ connection: xpc_connection_t) -> Bool {
    let replied = DispatchSemaphore(value: 0)
    var ok = false
    let barrier = message("IndigoKeyboardButtonEvent", ["usageCode": 0, "state": 2], barrier: true)
    xpc_connection_send_message_with_reply(connection, barrier, DispatchQueue.global()) { reply in
      ok = xpc_get_type(reply) == XPC_TYPE_DICTIONARY
      replied.signal()
    }
    guard replied.wait(timeout: .now() + 4) == .success, ok else { return false }
    // The daemon opens its HID devices once the peer activates; events sent before that are lost.
    Thread.sleep(forTimeInterval: 0.2)
    return true
  }

  static func message(_ type: String, _ payload: xpc_object_t, barrier: Bool = false) -> xpc_object_t {
    let message = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_string(message, "messageType", type)
    xpc_dictionary_set_bool(message, "isBarrier", barrier)
    xpc_dictionary_set_string(message, "featureIdentifier", service)
    xpc_dictionary_set_value(message, "payload", payload)
    return message
  }

  static func message(_ type: String, _ fields: [String: UInt64], barrier: Bool = false) -> xpc_object_t {
    let payload = xpc_dictionary_create(nil, nil, 0)
    for (key, value) in fields { xpc_dictionary_set_uint64(payload, key, value) }
    return message(type, payload, barrier: barrier)
  }

  /// `x` and `y` are fractions of the portrait screen from its top left. `phase` is 0 start, 1 move, 2 end.
  func touch(x: Double, y: Double, phase: UInt64) {
    let point = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_double(point, "x", x)
    xpc_dictionary_set_double(point, "y", y)
    let payload = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_value(payload, "pointOne", point)
    xpc_dictionary_set_uint64(payload, "eventType", phase)
    xpc_dictionary_set_uint64(payload, "edge", 0)
    xpc_dictionary_set_uint64(payload, "target", 0)
    xpc_connection_send_message(connection, HID.message("IndigoDigitizerEvent", payload))
  }

  /// A Keyboard page (0x07) usage.
  func key(usage: UInt64, down: Bool) {
    xpc_connection_send_message(
      connection, HID.message("IndigoKeyboardButtonEvent", ["usageCode": usage, "state": down ? 1 : 2]))
  }

  /// A Consumer page (0x0C) usage, which is how dtuhidd names the hardware buttons.
  func consumer(usage: UInt64, down: Bool) {
    xpc_connection_send_message(
      connection, HID.message("IndigoButtonEvent", ["usagePage": 0x0C, "usageCode": usage, "state": down ? 1 : 2]))
  }

  /// A GSEvent to SpringBoard's PurpleWorkspacePort. `orientation` is a UIDeviceOrientation, 1 to 4.
  func rotate(_ orientation: UInt32) {
    var buffer = [UInt8](repeating: 0, count: 112)
    func write(_ value: UInt32, at offset: Int) {
      withUnsafeBytes(of: value.littleEndian) { buffer.replaceSubrange(offset..<offset + 4, with: $0) }
    }
    write(0x13, at: 0x00)  // MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0)
    write(108, at: 0x04)
    write(lookupPort(device, "PurpleWorkspacePort"), at: 0x08)
    write(0x7B, at: 0x14)
    write(50 | 0x2_0000, at: 0x18)  // GSEventTypeDeviceOrientationChanged | GSEventHostFlag
    write(4, at: 0x48)
    write(orientation, at: 0x4C)
    let result = buffer.withUnsafeMutableBytes { bytes -> kern_return_t in
      let header = bytes.baseAddress!.assumingMemoryBound(to: mach_msg_header_t.self)
      return mach_msg(
        header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, 108, 0, mach_port_t(MACH_PORT_NULL), 2000, mach_port_t(MACH_PORT_NULL))
    }
    if result != KERN_SUCCESS { fail("rotate: \(String(cString: mach_error_string(result)))") }
  }
}
