import type { PlatformSupport } from "../../../shared/device.ts"
import { devicesLayer } from "./Devices.ts"
import { DeviceError, type DevicePlatformDriver } from "./platform.ts"

export const unavailableDriver = (support: PlatformSupport): DevicePlatformDriver => {
  const refuse = () => Promise.reject(new DeviceError("This machine cannot run this platform."))
  return {
    support: () => Promise.resolve(support),
    list: () => Promise.resolve([]),
    models: () => Promise.resolve([]),
    boot: refuse,
    create: refuse,
    remove: refuse,
    connect: refuse,
    screenshot: refuse,
    describe: refuse,
    launch: refuse,
  }
}

export const unavailableDevicesLayer = devicesLayer({
  drivers: {
    ios: unavailableDriver({ kind: "missing", tool: "xcode" }),
    android: unavailableDriver({ kind: "missing", tool: "androidSdk" }),
  },
  simslimAvailable: () => Promise.resolve(false),
})
