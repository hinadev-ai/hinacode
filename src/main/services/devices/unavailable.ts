import type { PlatformSupport } from "../../../shared/device.ts"
import { devicesLayer } from "./Devices.ts"
import { DeviceError, type DevicePlatformDriver } from "./platform.ts"

/** A platform this machine cannot run: it lists nothing and refuses every device call. */
export const unavailableDriver = (support: PlatformSupport): DevicePlatformDriver => {
  const refuse = () => Promise.reject(new DeviceError("This machine cannot run this platform."))
  return {
    support: () => Promise.resolve(support),
    list: () => Promise.resolve([]),
    boot: refuse,
    create: refuse,
    remove: refuse,
    connect: refuse,
    screenshot: refuse,
    describe: refuse,
    launch: refuse,
  }
}

/** Devices on a machine with neither SDK, for tests that build the whole app. */
export const unavailableDevicesLayer = devicesLayer({
  drivers: {
    ios: unavailableDriver({ kind: "missing", tool: "xcode" }),
    android: unavailableDriver({ kind: "missing", tool: "androidSdk" }),
  },
  simslimAvailable: () => Promise.resolve(false),
})
