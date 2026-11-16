import { tmpdir } from "node:os"
import { join } from "node:path"
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
    shutdown: refuse,
    remove: refuse,
    connect: refuse,
    describe: refuse,
    launch: refuse,
    checks: () => Promise.resolve([]),
    setup: refuse,
    install: refuse,
    logs: refuse,
    audio: refuse,
  }
}

export const unavailableDevicesLayer = devicesLayer({
  drivers: {
    ios: unavailableDriver({ kind: "missing", tool: "xcode" }),
    android: unavailableDriver({ kind: "missing", tool: "androidSdk" }),
  },
  uploadsDir: join(tmpdir(), `hinacode-device-uploads-${process.pid}`),
})
