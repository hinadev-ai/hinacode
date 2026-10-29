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

/** A live connection to a booted device: its screen as frames, and input. One per device, shared by every viewer. */
export interface DeviceLink {
  readonly screen: DeviceScreen
  /** Applies commands in order. Touch, scroll, key, text, button and rotate go through the device's input; the rest through its tools. */
  readonly send: (commands: ReadonlyArray<DeviceCommand>) => Promise<void>
  /** Resolves with a reason once the link stops on its own, such as the device shutting down or the producer crashing. */
  readonly ended: Promise<string>
  readonly close: () => Promise<void>
}

/** One platform's devices on this machine. Every method shells out or talks to the platform's own tools. */
export interface DevicePlatformDriver {
  readonly support: () => Promise<PlatformSupport>
  /** Every device on this machine. `ownerThreadId` is null; the Devices service fills it in. */
  readonly list: () => Promise<ReadonlyArray<Device>>
  /** The models `create` can make. Empty for platforms without per-thread devices. */
  readonly models: () => Promise<ReadonlyArray<SimulatorModel>>
  /** Boots a shut-down device and resolves once it can take input. Resolves at once for a booted one. */
  readonly boot: (id: DeviceId, onStep: (step: PrepareStep) => void) => Promise<void>
  /**
   * Creates, slims when it can, and boots a device for a thread. Platforms without per-thread devices reject.
   * A null `model` picks a default. `onCreated` runs once the device exists, before the slow steps, so the caller
   * can record it for cleanup.
   */
  readonly create: (
    name: string,
    model: SimulatorModelId | null,
    onStep: (step: PrepareStep) => void,
    onCreated: (id: DeviceId) => Promise<void>,
  ) => Promise<DeviceId>
  /** Stops and deletes a device: one HinaCode created, or any the user chose to delete. */
  readonly remove: (id: DeviceId) => Promise<void>
  readonly connect: (id: DeviceId, onFrame: (frame: Frame) => void) => Promise<DeviceLink>
  /** A full-resolution PNG of the screen, for agent tools and picks. */
  readonly screenshot: (id: DeviceId) => Promise<Buffer>
  /** The accessibility tree, flattened, with frames in screen points. */
  readonly describe: (id: DeviceId) => Promise<ReadonlyArray<DeviceElement>>
  /** Launches an installed app by bundle id or package name. */
  readonly launch: (id: DeviceId, app: string) => Promise<void>
}
