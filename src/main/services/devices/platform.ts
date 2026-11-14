import type {
  Device,
  DeviceCheck,
  Requirement,
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

export interface AudioLink {
  readonly rate: number
  readonly channels: number
  readonly ended: Promise<string>
  readonly close: () => Promise<void>
}

export const notBuiltYet = () => Promise.reject(new DeviceError("Not built yet."))

export const LOG_LINES = 200
export const lastLines = (text: string) => text.trimEnd().split("\n").slice(-LOG_LINES).join("\n")

export interface DevicePlatformDriver {
  readonly checks: () => Promise<ReadonlyArray<DeviceCheck>>
  readonly setup: (requirement: Requirement) => Promise<void>
  readonly install: (id: DeviceId, path: string) => Promise<string | null>
  readonly logs: (id: DeviceId, app: string | null, sinceSeconds: number) => Promise<string>
  readonly audio: (id: DeviceId, onPcm: (pcm: Buffer) => void) => Promise<AudioLink>
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
  readonly shutdown: (id: DeviceId) => Promise<void>
  readonly remove: (id: DeviceId) => Promise<void>
  readonly connect: (id: DeviceId, onFrame: (frame: Frame) => void) => Promise<DeviceLink>
  readonly describe: (id: DeviceId) => Promise<ReadonlyArray<DeviceElement>>
  readonly launch: (id: DeviceId, app: string) => Promise<void>
}
