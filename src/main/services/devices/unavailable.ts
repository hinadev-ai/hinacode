import type { PlatformSupport } from "../../../shared/device.ts"
import { type DevicesOptions, devicesLayer } from "./Devices.ts"
import { DeviceError, type DevicePlatformDriver } from "./platform.ts"

export const unavailableDriver = (support: PlatformSupport): DevicePlatformDriver => {
  const refuse = () => Promise.reject(new DeviceError("This machine cannot run this platform."))
  return {
    support: () => Promise.resolve(support),
    list: () => Promise.resolve([]),
    models: () => Promise.resolve([]),
    boot: refuse,
    create: refuse,
    shutdown: refuse,
    remove: refuse,
    connect: refuse,
    describe: refuse,
    launch: refuse,
  }
}

export const unavailableDevices: DevicesOptions = {
  drivers: {
    ios: unavailableDriver({ kind: "missing", tool: "xcode" }),
    android: unavailableDriver({ kind: "missing", tool: "androidSdk" }),
  },
  simslimAvailable: () => Promise.resolve(false),
}

export const unavailableDevicesLayer = devicesLayer(unavailableDevices)
