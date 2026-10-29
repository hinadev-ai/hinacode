import { describe, expect, it, vi } from "vitest"
import type { BoatSandbox } from "../boat/Boat.ts"
import { BOAT_DEVICE_ID, type BoatDeviceRunner, makeBoatAndroidDriver, withBoatAndroid } from "./boatAndroid.ts"
import { DeviceError, type DevicePlatformDriver, type Frame } from "./platform.ts"

const refuse = () => Promise.reject(new DeviceError("local stub"))
const stubLocalDriver = (list: DevicePlatformDriver["list"]): DevicePlatformDriver => ({
  support: async () => ({ kind: "ready" }),
  list,
  models: async () => [],
  boot: refuse,
  create: refuse,
  remove: refuse,
  connect: refuse,
  screenshot: refuse,
  describe: refuse,
  launch: refuse,
})

const png = (width: number, height: number, fill = 1) => {
  const bytes = Buffer.alloc(32, fill)
  bytes[0] = 0x89
  bytes[1] = 0x50
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

interface FakeRunner extends BoatDeviceRunner {
  readonly scripts: Array<string>
  readonly detached: Array<string>
  readonly state: { sandbox?: BoatSandbox; booted: boolean; frame: Buffer }
}

const makeFakeRunner = (): FakeRunner => {
  const scripts: Array<string> = []
  const detached: Array<string> = []
  const state: { sandbox?: BoatSandbox; booted: boolean; frame: Buffer } = { booted: false, frame: png(540, 1200) }
  const ok = (stdout = "") => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) })
  return {
    scripts,
    detached,
    state,
    configured: async () => true,
    list: async () => (state.sandbox ? [state.sandbox] : []),
    create: async (input) => {
      state.sandbox = { id: "bx_dev00001", name: input.name, state: "ready", labels: { ...input.labels } }
      return { id: state.sandbox.id }
    },
    resume: async () => {
      if (state.sandbox) state.sandbox = { ...state.sandbox, state: "ready" }
    },
    waitReady: async () => undefined,
    remove: async () => {
      state.sandbox = undefined
      state.booted = false
    },
    exec: async (_id, script) => {
      scripts.push(script)
      if (script.includes("getprop sys.boot_completed") && script.includes("seq 1 120")) {
        state.booted = true
        return ok()
      }
      if (script.includes("getprop sys.boot_completed")) return ok(state.booted ? "1\n" : "\n")
      if (script.includes("hinacode-android-ready") && script.includes("test -f")) return ok("")
      if (script.includes("wm size")) return ok("Physical size: 1080x2400\nPhysical density: 420\n")
      if (script.includes("uiautomator dump"))
        return ok(
          `<?xml version="1.0"?><hierarchy><node class="android.widget.Button" text="Save" resource-id="app:id/save" content-desc="" clickable="true" bounds="[0,0][420,210]" /></hierarchy>`,
        )
      if (script.includes("resolve-activity")) return ok("priority=0\ncom.example.app/.MainActivity\n")
      return ok()
    },
    execDetached: async (_id, script) => {
      detached.push(script)
    },
    readFile: async () => state.frame,
  }
}

describe("boat Android driver", () => {
  it("lists one cloud device and refuses create like local Android", async () => {
    const driver = makeBoatAndroidDriver(makeFakeRunner())
    expect(await driver.support()).toEqual({ kind: "ready" })
    const devices = await driver.list()
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({
      id: BOAT_DEVICE_ID,
      platform: "android",
      name: "Boat Android (cloud)",
      state: "shutdown",
    })
    await expect(
      driver.create(
        "x",
        null,
        () => undefined,
        async () => undefined,
      ),
    ).rejects.toThrow("Attach an existing emulator")
  })

  it("creates the sandbox, installs Android once and boots the emulator", async () => {
    const runner = makeFakeRunner()
    const driver = makeBoatAndroidDriver(runner)
    const steps: Array<string> = []
    await driver.boot(BOAT_DEVICE_ID, (step) => steps.push(step))
    expect(steps).toEqual(["creating", "booting"])
    expect(runner.state.sandbox?.labels["hinacode-kind"]).toBe("android-device")
    expect(runner.scripts.some((script) => script.includes("sdkmanager"))).toBe(true)
    expect(runner.scripts.some((script) => script.includes("avdmanager"))).toBe(true)
    expect(runner.detached).toHaveLength(1)
    expect(runner.detached[0]).toContain("emulator -avd phone")

    const devices = await driver.list()
    expect(devices[0]?.state).toBe("booted")
  })

  it("resumes an archived sandbox instead of creating a second one", async () => {
    const runner = makeFakeRunner()
    runner.state.sandbox = {
      id: "bx_dev00001",
      name: "hinacode-android",
      state: "archived",
      labels: { "hinacode-kind": "android-device" },
    }
    runner.state.booted = true
    const driver = makeBoatAndroidDriver(runner)
    await driver.boot(BOAT_DEVICE_ID, () => undefined)
    expect(runner.state.sandbox.state).toBe("ready")
    expect(runner.detached).toHaveLength(0)
  })

  it("streams changed frames only and maps input to adb shell lines", async () => {
    const runner = makeFakeRunner()
    runner.state.sandbox = {
      id: "bx_dev00001",
      name: "hinacode-android",
      state: "ready",
      labels: { "hinacode-kind": "android-device" },
    }
    runner.state.booted = true
    const driver = makeBoatAndroidDriver(runner)
    const frames: Array<Frame> = []
    const link = await driver.connect(BOAT_DEVICE_ID, (frame) => frames.push(frame))
    expect(link.screen).toEqual({ width: 1080 / 2.625, height: 2400 / 2.625, scale: 2.625 })

    await vi.waitFor(() => expect(frames).toHaveLength(1), { timeout: 3000 })
    expect(frames[0]).toMatchObject({ mime: "image/png", width: 540, height: 1200, orientation: "portrait" })

    runner.state.frame = png(540, 1200, 2)
    await vi.waitFor(() => expect(frames).toHaveLength(2), { timeout: 3000 })

    await link.send([
      { kind: "touch", phase: "down", x: 0.5, y: 0.5 },
      { kind: "touch", phase: "up", x: 0.5, y: 0.5 },
      { kind: "button", button: "back" },
      { kind: "text", text: "hi there" },
    ])
    const sent = runner.scripts.at(-1) ?? ""
    expect(sent).toContain("input motionevent DOWN 540 1200")
    expect(sent).toContain("input motionevent UP 540 1200")
    expect(sent).toContain("input keyevent 4")
    expect(sent).toContain("hi%sthere")

    await link.send([{ kind: "key", phase: "down", code: "Enter" }])
    expect(runner.scripts.at(-1)).toContain("input keyevent 66")

    await link.close()
    await expect(link.send([{ kind: "button", button: "home" }])).rejects.toThrow("screen was closed")
  })

  it("describes the UI through uiautomator and launches by component", async () => {
    const runner = makeFakeRunner()
    runner.state.sandbox = {
      id: "bx_dev00001",
      name: "hinacode-android",
      state: "ready",
      labels: { "hinacode-kind": "android-device" },
    }
    const driver = makeBoatAndroidDriver(runner)
    const elements = await driver.describe(BOAT_DEVICE_ID)
    expect(elements).toHaveLength(1)
    expect(elements[0]).toMatchObject({ label: "Save", identifier: "app:id/save" })
    expect(elements[0]?.frame.width).toBeCloseTo(420 / 2.625)

    await driver.launch(BOAT_DEVICE_ID, "com.example.app")
    expect(runner.scripts.at(-1)).toContain("am start -n com.example.app/.MainActivity")
    await expect(driver.launch(BOAT_DEVICE_ID, "not a package")).rejects.toThrow("not an Android package name")
  })

  it("refuses non-ASCII text instead of dropping characters", async () => {
    const runner = makeFakeRunner()
    runner.state.sandbox = {
      id: "bx_dev00001",
      name: "hinacode-android",
      state: "ready",
      labels: { "hinacode-kind": "android-device" },
    }
    runner.state.booted = true
    const driver = makeBoatAndroidDriver(runner)
    const link = await driver.connect(BOAT_DEVICE_ID, () => undefined)
    await expect(link.send([{ kind: "text", text: "こんにちは" }])).rejects.toThrow("not supported")
    await link.close()
  })

  it("propagates a sandbox lookup failure on remove instead of reporting success", async () => {
    const runner = makeFakeRunner()
    const failing: BoatDeviceRunner = {
      ...runner,
      list: async () => {
        throw new Error("network down")
      },
    }
    const driver = makeBoatAndroidDriver(failing)
    await expect(driver.remove(BOAT_DEVICE_ID)).rejects.toThrow("network down")
  })

  it("recreates the sandbox when its snapshot has expired", async () => {
    const runner = makeFakeRunner()
    runner.state.sandbox = {
      id: "bx_old00001",
      name: "hinacode-android",
      state: "archived",
      labels: { "hinacode-kind": "android-device" },
    }
    const expired: BoatDeviceRunner = {
      ...runner,
      resume: async () => {
        throw Object.assign(new Error("The stored boat snapshot has expired."), { _tag: "BoatSnapshotExpiredError" })
      },
    }
    const driver = makeBoatAndroidDriver(expired)
    await driver.boot(BOAT_DEVICE_ID, () => undefined)
    expect(runner.state.sandbox?.id).toBe("bx_dev00001")
    expect(runner.detached).toHaveLength(1)
  })

  it("composite keeps local devices and dispatches boat ids to the boat driver", async () => {
    const runner = makeFakeRunner()
    const boat = makeBoatAndroidDriver(runner)
    const localDevice = {
      id: "android:Pixel_8" as const,
      platform: "android" as const,
      name: "Pixel 8",
      osVersion: "Android 14",
      state: "shutdown" as const,
      slim: null,
      memoryBytes: null,
      ownerThreadId: null,
    }
    const local = stubLocalDriver(async () => [localDevice])
    const composite = withBoatAndroid(local, boat)
    expect(await composite.support()).toEqual({ kind: "ready" })
    const devices = await composite.list()
    expect(devices.map((device) => device.id)).toEqual(["android:Pixel_8", BOAT_DEVICE_ID])
    await composite.remove(BOAT_DEVICE_ID)
    expect(runner.state.sandbox).toBeUndefined()
  })
})
