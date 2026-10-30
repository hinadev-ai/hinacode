import { Schema } from "effect"

export const DevicePlatform = Schema.Literals(["ios", "android"])
export type DevicePlatform = typeof DevicePlatform.Type

// FIXME: adb serials change across reboots, so Android ids use the AVD name
export const DeviceId = Schema.String.check(Schema.isPattern(/^(ios:[0-9A-F-]{36}|android:[\w.-]{1,100})$/))
export type DeviceId = typeof DeviceId.Type

export const devicePlatformOf = (id: DeviceId): DevicePlatform => (id.startsWith("ios:") ? "ios" : "android")

export const Device = Schema.Struct({
  id: DeviceId,
  platform: DevicePlatform,
  name: Schema.String,
  osVersion: Schema.String,
  state: Schema.Literals(["shutdown", "booting", "booted"]),
  slim: Schema.NullOr(Schema.Struct({ disabled: Schema.Int, total: Schema.Int })),
  memoryBytes: Schema.NullOr(Schema.Number),
  ownerThreadId: Schema.NullOr(Schema.String),
})
export type Device = typeof Device.Type

export const PlatformSupport = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("unsupported"), reason: Schema.Literal("notMac") }),
  Schema.Struct({ kind: Schema.Literal("missing"), tool: Schema.Literals(["xcode", "androidSdk"]) }),
])
export type PlatformSupport = typeof PlatformSupport.Type

const SimctlIdentifier = Schema.String.check(Schema.isMaxLength(300))

export const SimulatorModelId = Schema.Struct({ deviceType: SimctlIdentifier, runtime: SimctlIdentifier })
export type SimulatorModelId = typeof SimulatorModelId.Type

export const SimulatorModel = Schema.Struct({
  ...SimulatorModelId.fields,
  name: Schema.String,
  family: Schema.String,
  osVersion: Schema.String,
})
export type SimulatorModel = typeof SimulatorModel.Type

export const DeviceHost = Schema.Struct({
  ios: PlatformSupport,
  android: PlatformSupport,
  simslim: Schema.Boolean,
  devices: Schema.Array(Device),
  models: Schema.Array(SimulatorModel),
})
export type DeviceHost = typeof DeviceHost.Type

export const DeviceControl = Schema.Literals(["agent", "user"])
export type DeviceControl = typeof DeviceControl.Type

export const DeviceScreen = Schema.Struct({ width: Schema.Number, height: Schema.Number, scale: Schema.Number })
export type DeviceScreen = typeof DeviceScreen.Type

export const PrepareStep = Schema.Literals(["creating", "slimming", "booting", "connecting"])
export type PrepareStep = typeof PrepareStep.Type

export const ThreadDevice = Schema.Union([
  Schema.Struct({
    phase: Schema.Literal("preparing"),
    deviceId: Schema.NullOr(DeviceId),
    name: Schema.String,
    owned: Schema.Boolean,
    step: PrepareStep,
  }),
  Schema.Struct({
    phase: Schema.Literal("ready"),
    device: Device,
    screen: DeviceScreen,
    control: DeviceControl,
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

export const threadDeviceOwned = (entry: ThreadDevice) =>
  entry.phase === "ready" ? entry.device.ownerThreadId !== null : entry.owned

export const ThreadDevices = Schema.Array(ThreadDevice)
export type ThreadDevices = typeof ThreadDevices.Type

const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Delta = Schema.Number.check(Schema.isBetween({ minimum: -10000, maximum: 10000 }))

export const DevicePosture = Schema.Literals(["closed", "halfOpen", "flat"])
export type DevicePosture = typeof DevicePosture.Type

export const DeviceButton = Schema.Literals(["home", "lock", "volumeUp", "volumeDown", "back", "recents"])
export type DeviceButton = typeof DeviceButton.Type

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
  Schema.Struct({ kind: Schema.Literal("scroll"), x: Fraction, y: Fraction, deltaX: Delta, deltaY: Delta }),
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
  data: Schema.String.check(Schema.isMaxLength(MAX_FRAME_LENGTH)),
  width: Schema.Int,
  height: Schema.Int,
  orientation: Schema.Literals(["portrait", "landscape"]),
  posture: Schema.optionalKey(DevicePosture),
  screen: Schema.optionalKey(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
  unfolded: Schema.optionalKey(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
})
export type DeviceFrame = typeof DeviceFrame.Type

export const DeviceElement = Schema.Struct({
  role: Schema.String.check(Schema.isMaxLength(100)),
  label: Schema.String.check(Schema.isMaxLength(500)),
  identifier: Schema.String.check(Schema.isMaxLength(500)),
  value: Schema.String.check(Schema.isMaxLength(500)),
  frame: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }),
})
export type DeviceElement = typeof DeviceElement.Type

export const PickedDeviceElement = Schema.Struct({
  device: Schema.String.check(Schema.isMaxLength(200)),
  platform: DevicePlatform,
  element: DeviceElement,
})
export type PickedDeviceElement = typeof PickedDeviceElement.Type
