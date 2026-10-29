import { Schema } from "effect"

export const DevicePlatform = Schema.Literals(["ios", "android"])
export type DevicePlatform = typeof DevicePlatform.Type

/** `ios:<UDID>` or `android:<AVD name>`. AVD names survive reboots, adb serials do not. */
export const DeviceId = Schema.String.check(Schema.isPattern(/^(ios:[0-9A-F-]{36}|android:[\w.-]{1,100})$/))
export type DeviceId = typeof DeviceId.Type

export const devicePlatformOf = (id: DeviceId): DevicePlatform => (id.startsWith("ios:") ? "ios" : "android")

export const Device = Schema.Struct({
  id: DeviceId,
  platform: DevicePlatform,
  name: Schema.String,
  osVersion: Schema.String,
  state: Schema.Literals(["shutdown", "booting", "booted"]),
  /** simslim's count of background services it turned off, or null when simslim is missing or the device is not iOS. */
  slim: Schema.NullOr(Schema.Struct({ disabled: Schema.Int, total: Schema.Int })),
  /** The measured footprint of a booted device. */
  memoryBytes: Schema.NullOr(Schema.Number),
  /** Set when HinaCode created the device for a thread. HinaCode only deletes devices it created. */
  ownerThreadId: Schema.NullOr(Schema.String),
})
export type Device = typeof Device.Type

/** Whether the machine can run a platform. The view renders the copy, so main sends no prose. */
export const PlatformSupport = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("unsupported"), reason: Schema.Literal("notMac") }),
  Schema.Struct({ kind: Schema.Literal("missing"), tool: Schema.Literals(["xcode", "androidSdk"]) }),
])
export type PlatformSupport = typeof PlatformSupport.Type

const SimctlIdentifier = Schema.String.check(Schema.isMaxLength(300))

/** Which simulator to create: a device type and the runtime to run it on, as `simctl create` takes them. */
export const SimulatorModelId = Schema.Struct({ deviceType: SimctlIdentifier, runtime: SimctlIdentifier })
export type SimulatorModelId = typeof SimulatorModelId.Type

/** A model HinaCode can create, on the newest installed runtime that runs it. */
export const SimulatorModel = Schema.Struct({
  ...SimulatorModelId.fields,
  name: Schema.String,
  /** `iPhone` or `iPad`, as the runtime reports it. */
  family: Schema.String,
  osVersion: Schema.String,
})
export type SimulatorModel = typeof SimulatorModel.Type

export const DeviceHost = Schema.Struct({
  ios: PlatformSupport,
  android: PlatformSupport,
  simslim: Schema.Boolean,
  devices: Schema.Array(Device),
  /** Empty unless iOS is ready. */
  models: Schema.Array(SimulatorModel),
})
export type DeviceHost = typeof DeviceHost.Type

export const DeviceControl = Schema.Literals(["agent", "user"])
export type DeviceControl = typeof DeviceControl.Type

/** The screen in points, as `DeviceFrame` wants it, plus the pixel density frames are captured at. */
export const DeviceScreen = Schema.Struct({ width: Schema.Number, height: Schema.Number, scale: Schema.Number })
export type DeviceScreen = typeof DeviceScreen.Type

export const PrepareStep = Schema.Literals(["creating", "slimming", "booting", "connecting"])
export type PrepareStep = typeof PrepareStep.Type

/**
 * One device a thread drives, as a state machine: preparing -> ready | failed, and ready -> failed when the device
 * goes away. Detaching removes it. `deviceId` is null only while a new simulator is being created, or if that failed.
 */
export const ThreadDevice = Schema.Union([
  Schema.Struct({
    phase: Schema.Literal("preparing"),
    deviceId: Schema.NullOr(DeviceId),
    name: Schema.String,
    /** HinaCode created it for this thread, so detaching deletes it. */
    owned: Schema.Boolean,
    step: PrepareStep,
  }),
  Schema.Struct({
    phase: Schema.Literal("ready"),
    device: Device,
    screen: DeviceScreen,
    control: DeviceControl,
    /** An agent input tool is waiting for the user to hand back. */
    agentWaiting: Schema.Boolean,
  }),
  Schema.Struct({
    phase: Schema.Literal("failed"),
    deviceId: Schema.NullOr(DeviceId),
    name: Schema.String,
    owned: Schema.Boolean,
    message: Schema.String,
  }),
])
export type ThreadDevice = typeof ThreadDevice.Type

export const threadDeviceId = (entry: ThreadDevice): DeviceId | null =>
  entry.phase === "ready" ? entry.device.id : entry.deviceId

export const threadDeviceName = (entry: ThreadDevice) => (entry.phase === "ready" ? entry.device.name : entry.name)

/** Whether detaching deletes the device, because HinaCode created it for the thread. */
export const threadDeviceOwned = (entry: ThreadDevice) =>
  entry.phase === "ready" ? entry.device.ownerThreadId !== null : entry.owned

/** A thread's devices in the order they were attached. At most one has a null id. */
export const ThreadDevices = Schema.Array(ThreadDevice)
export type ThreadDevices = typeof ThreadDevices.Type

/** A fraction of the screen's width or height, so input maps the same at any frame scale. */
const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Delta = Schema.Number.check(Schema.isBetween({ minimum: -10000, maximum: 10000 }))

/** How far a foldable is open: its cover screen shows when closed, its inner screen otherwise. */
export const DevicePosture = Schema.Literals(["closed", "halfOpen", "flat"])
export type DevicePosture = typeof DevicePosture.Type

export const DeviceButton = Schema.Literals(["home", "lock", "volumeUp", "volumeDown", "back", "recents"])
export type DeviceButton = typeof DeviceButton.Type

/** Deep links are the point, so any scheme is allowed. The device's OS decides what opens it. */
export const DeviceUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/),
)

export const DeviceCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("touch"),
    phase: Schema.Literals(["down", "move", "up"]),
    x: Fraction,
    y: Fraction,
  }),
  /** Wheel deltas in CSS pixels of the displayed screen. */
  Schema.Struct({ kind: Schema.Literal("scroll"), x: Fraction, y: Fraction, deltaX: Delta, deltaY: Delta }),
  /** A DOM `KeyboardEvent.code`, so layouts map to the device's physical keys. */
  Schema.Struct({
    kind: Schema.Literal("key"),
    phase: Schema.Literals(["down", "up"]),
    code: Schema.String.check(Schema.isMaxLength(40)),
  }),
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String.check(Schema.isMaxLength(10000)) }),
  Schema.Struct({ kind: Schema.Literal("button"), button: DeviceButton }),
  Schema.Struct({ kind: Schema.Literal("rotate") }),
  Schema.Struct({ kind: Schema.Literal("posture"), posture: DevicePosture }),
  Schema.Struct({ kind: Schema.Literal("appearance"), mode: Schema.Literals(["light", "dark"]) }),
  Schema.Struct({ kind: Schema.Literal("openUrl"), url: DeviceUrl }),
])
export type DeviceCommand = typeof DeviceCommand.Type

const MAX_FRAME_LENGTH = 4 * 1024 * 1024

export const DeviceFrame = Schema.Struct({
  sequence: Schema.Int,
  mime: Schema.Literals(["image/jpeg", "image/png"]),
  /** Base64. */
  data: Schema.String.check(Schema.isMaxLength(MAX_FRAME_LENGTH)),
  /** Pixels of this image, which may be scaled down from the device's. */
  width: Schema.Int,
  height: Schema.Int,
  /** Frames arrive rotated to what the screen shows, so the canvas follows the device. */
  orientation: Schema.Literals(["portrait", "landscape"]),
  /** Only on a foldable. */
  posture: Schema.optionalKey(DevicePosture),
  /** The screen this frame shows, in points and before rotation, when it is not the device's main screen size. */
  screen: Schema.optionalKey(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
})
export type DeviceFrame = typeof DeviceFrame.Type

/** A UI element from the device's accessibility tree. Frames are in screen points. */
export const DeviceElement = Schema.Struct({
  role: Schema.String.check(Schema.isMaxLength(100)),
  label: Schema.String.check(Schema.isMaxLength(500)),
  identifier: Schema.String.check(Schema.isMaxLength(500)),
  value: Schema.String.check(Schema.isMaxLength(500)),
  frame: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }),
})
export type DeviceElement = typeof DeviceElement.Type

/** What the user picked on a device screen, attached to the composer next to its crop. */
export const PickedDeviceElement = Schema.Struct({
  device: Schema.String.check(Schema.isMaxLength(200)),
  platform: DevicePlatform,
  element: DeviceElement,
})
export type PickedDeviceElement = typeof PickedDeviceElement.Type
