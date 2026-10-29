import type {
  Device,
  DeviceCommand,
  DeviceElement,
  DeviceFrame,
  DeviceId,
  DeviceScreen,
  PlatformSupport,
  PrepareStep,
  SimulatorModel,
  SimulatorModelId,
} from "../../../shared/device.ts"

export class DeviceError extends Error {}

export type Frame = Omit<DeviceFrame, "sequence" | "data"> & { readonly data: Buffer }

export interface DeviceLink {
  readonly screen: DeviceScreen
  readonly send: (commands: ReadonlyArray<DeviceCommand>) => Promise<void>
  readonly ended: Promise<string>
  readonly close: () => Promise<void>
}

export interface DevicePlatformDriver {
  readonly support: () => Promise<PlatformSupport>
  readonly list: () => Promise<ReadonlyArray<Device>>
  readonly models: () => Promise<ReadonlyArray<SimulatorModel>>
  readonly boot: (id: DeviceId, onStep: (step: PrepareStep) => void) => Promise<void>
  readonly create: (
    name: string,
    model: SimulatorModelId | null,
    onStep: (step: PrepareStep) => void,
    onCreated: (id: DeviceId) => Promise<void>,
  ) => Promise<DeviceId>
  readonly remove: (id: DeviceId) => Promise<void>
  readonly connect: (id: DeviceId, onFrame: (frame: Frame) => void) => Promise<DeviceLink>
  readonly screenshot: (id: DeviceId) => Promise<Buffer>
  readonly describe: (id: DeviceId) => Promise<ReadonlyArray<DeviceElement>>
  readonly launch: (id: DeviceId, app: string) => Promise<void>
}
