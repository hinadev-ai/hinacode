import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { access, readdir, readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir, tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import * as grpc from "@grpc/grpc-js"
import * as protoLoader from "@grpc/proto-loader"
import type { Device, DeviceCommand, DeviceId, PlatformSupport } from "../../../shared/device.ts"
import {
  androidVersionOf,
  panelPoint,
  parseDiscoveryFile,
  parseIni,
  parseUiHierarchy,
  quoteForRemoteShell,
  type RunningEmulator,
  type SkinRotation,
} from "./androidParsers.ts"
import { DeviceError, type DeviceLink, type DevicePlatformDriver } from "./platform.ts"

interface ImageFormat {
  readonly format: "PNG"
  readonly width: number
  readonly height: number
}

interface Image {
  readonly format: {
    readonly width: number
    readonly height: number
    readonly rotation: { rotation: SkinRotation } | null
  }
  readonly image: Buffer
}

interface DisplayConfigurations {
  readonly displays: ReadonlyArray<{ display: number; width: number; height: number; dpi: number }>
}

type Unary<Request, Response> = (
  request: Request,
  metadata: grpc.Metadata,
  callback: (error: grpc.ServiceError | null, response: Response) => void,
) => grpc.ClientUnaryCall

/** The slice of `EmulatorController` in `<sdk>/emulator/lib/emulator_controller.proto` this driver calls. */
interface EmulatorController extends grpc.Client {
  readonly getDisplayConfigurations: Unary<object, DisplayConfigurations>
  readonly getScreenshot: Unary<ImageFormat, Image>
  readonly streamScreenshot: (request: ImageFormat, metadata: grpc.Metadata) => grpc.ClientReadableStream<Image>
  readonly sendTouch: Unary<
    { touches: ReadonlyArray<{ x: number; y: number; identifier: number; pressure: number }> },
    object
  >
  readonly getPhysicalModel: Unary<{ target: "ROTATION" }, { value: { data: ReadonlyArray<number> } | null }>
  readonly setPhysicalModel: Unary<{ target: "ROTATION"; value: { data: ReadonlyArray<number> } }, object>
  readonly setClipboard: Unary<{ text: string }, object>
}

type EmulatorControllerClass = new (
  address: string,
  credentials: grpc.ChannelCredentials,
  options: grpc.ChannelOptions,
) => EmulatorController

const BOOT_TIMEOUT_MS = 4 * 60 * 1000
const FRAME_SHORT_SIDE = 540
const MAX_STREAM_RESTARTS = 3
const FIRST_GRPC_PORT = 8600
/** About one wheel notch on Android, which scrolls by 64 dp. Wheel deltas are CSS pixels of a screen drawn near 1 dp per pixel. */
const PIXELS_PER_SCROLL_UNIT = 64
const NO_GRPC = "This emulator was started without its gRPC endpoint. Close it and attach it again from HinaCode."
const CREATE_UNSUPPORTED = "HinaCode creates simulators only for iOS. Attach an existing emulator."

const execFileAsync = promisify(execFile)
const run = async (file: string, args: ReadonlyArray<string>, timeout = 30_000) =>
  (await execFileAsync(file, args, { timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" })).stdout

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const sdkRootOf = (override: string | undefined) =>
  override ||
  process.env["ANDROID_HOME"] ||
  process.env["ANDROID_SDK_ROOT"] ||
  (process.platform === "darwin" ? join(homedir(), "Library", "Android", "sdk") : join(homedir(), "Android", "Sdk"))

/** Where the emulator writes `pid_<pid>.ini` for each running instance, per its `ConfigDirs::getDiscoveryDirectory`. */
const discoveryDirs = () => {
  if (process.platform === "darwin") return [join(homedir(), "Library", "Caches", "TemporaryItems", "avd", "running")]
  const xdg = process.env["XDG_RUNTIME_DIR"]
  const fallback = join(tmpdir(), `android-${userInfo().username}`, "avd", "running")
  return xdg ? [join(xdg, "avd", "running"), fallback] : [fallback]
}

const avdHome = () =>
  process.env["ANDROID_AVD_HOME"] || join(process.env["ANDROID_USER_HOME"] || join(homedir(), ".android"), "avd")

const AVD_NAME = /^[\w.-]{1,100}$/
const PACKAGE_NAME = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/

const avdNameOf = (id: DeviceId) => {
  const name = id.slice("android:".length)
  if (!id.startsWith("android:") || !AVD_NAME.test(name)) throw new DeviceError("This is not an Android device.")
  return name
}

const freePort = async (from: number): Promise<number> => {
  for (let port = from; port < from + 100; port++) {
    const server = createServer()
    const free = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(port, () => resolve(true))
    })
    if (free) {
      await new Promise((resolve) => server.close(resolve))
      return port
    }
  }
  throw new DeviceError("No free port for the emulator's gRPC endpoint.")
}

/** DOM `KeyboardEvent.code` to Android `KeyEvent` keycodes, for `input keyevent`. */
const KEYCODES: ReadonlyMap<string, number> = new Map(
  Object.entries({
    ...Object.fromEntries(
      Array.from({ length: 26 }, (_, index) => [`Key${String.fromCharCode(65 + index)}`, 29 + index]),
    ),
    ...Object.fromEntries(Array.from({ length: 10 }, (_, digit) => [`Digit${digit}`, 7 + digit])),
    Enter: 66,
    NumpadEnter: 66,
    Escape: 111,
    Backspace: 67,
    Tab: 61,
    Space: 62,
    Minus: 69,
    Equal: 70,
    BracketLeft: 71,
    BracketRight: 72,
    Backslash: 73,
    Semicolon: 74,
    Quote: 75,
    Backquote: 68,
    Comma: 55,
    Period: 56,
    Slash: 76,
    CapsLock: 115,
    Delete: 112,
    Home: 122,
    End: 123,
    PageUp: 92,
    PageDown: 93,
    ArrowUp: 19,
    ArrowDown: 20,
    ArrowLeft: 21,
    ArrowRight: 22,
  }),
)
const MODIFIER_KEYCODES: ReadonlyMap<string, number> = new Map(
  Object.entries({
    ShiftLeft: 59,
    ShiftRight: 60,
    AltLeft: 57,
    AltRight: 58,
    ControlLeft: 113,
    ControlRight: 114,
    MetaLeft: 117,
    MetaRight: 118,
  }),
)
const BUTTON_KEYCODES = { home: 3, back: 4, recents: 187, lock: 26, volumeUp: 24, volumeDown: 25 } as const
const KEYCODE_ENTER = 66
const KEYCODE_PASTE = 279

const loadController = (() => {
  const loaded = new Map<string, Promise<EmulatorControllerClass>>()
  return (sdk: string) => {
    const lib = join(sdk, "emulator", "lib")
    const existing = loaded.get(lib)
    if (existing) return existing
    const controller = protoLoader
      .load(join(lib, "emulator_controller.proto"), {
        includeDirs: [lib],
        keepCase: true,
        enums: String,
        longs: Number,
        defaults: true,
      })
      .then((definition) => {
        const root = grpc.loadPackageDefinition(definition) as unknown as {
          android: { emulation: { control: { EmulatorController: EmulatorControllerClass } } }
        }
        return root.android.emulation.control.EmulatorController
      })
    loaded.set(lib, controller)
    controller.catch(() => loaded.delete(lib))
    return controller
  }
})()

const running = async (): Promise<ReadonlyMap<string, RunningEmulator>> => {
  const found = new Map<string, RunningEmulator>()
  for (const dir of discoveryDirs()) {
    const files = await readdir(dir).catch(() => [])
    for (const file of files) {
      const text = await readFile(join(dir, file), "utf8").catch(() => "")
      const emulator = parseDiscoveryFile(file, text)
      if (emulator && isAlive(emulator.pid)) found.set(emulator.avdName, emulator)
    }
  }
  return found
}

const memoryOf = (pid: number) =>
  run("ps", ["-o", "rss=", "-p", String(pid)]).then(
    (output) => Number(output.trim()) * 1024 || null,
    () => null,
  )

const avdConfig = async (name: string) => {
  const pointer = parseIni(await readFile(join(avdHome(), `${name}.ini`), "utf8").catch(() => ""))
  const dir = pointer.get("path") ?? join(avdHome(), `${name}.avd`)
  return parseIni(await readFile(join(dir, "config.ini"), "utf8").catch(() => ""))
}

const runningEmulator = async (id: DeviceId) => {
  const emulator = (await running()).get(avdNameOf(id))
  if (!emulator) throw new DeviceError("This emulator is not running.")
  return emulator
}

const refuseCreate = () => Promise.reject(new DeviceError(CREATE_UNSUPPORTED))

export const makeAndroidDriver = (options: { sdkRoot?: string } = {}): DevicePlatformDriver => {
  const sdk = sdkRootOf(options.sdkRoot)
  const emulatorBinary = join(sdk, "emulator", "emulator")
  const adbBinary = join(sdk, "platform-tools", "adb")

  const adb = (emulator: RunningEmulator, args: ReadonlyArray<string>, timeout?: number) =>
    run(adbBinary, ["-s", `emulator-${emulator.serialPort}`, ...args], timeout)
  const shell = (emulator: RunningEmulator, ...args: ReadonlyArray<string>) => adb(emulator, ["shell", ...args])

  const bootCompleted = (emulator: RunningEmulator) =>
    shell(emulator, "getprop", "sys.boot_completed").then(
      (output) => output.trim() === "1",
      () => false,
    )

  const openController = async (emulator: RunningEmulator) => {
    if (emulator.grpcPort === null) throw new DeviceError(NO_GRPC)
    const Controller = await loadController(sdk)
    const client = new Controller(`127.0.0.1:${emulator.grpcPort}`, grpc.credentials.createInsecure(), {
      "grpc.max_receive_message_length": 64 * 1024 * 1024,
    })
    const metadata = new grpc.Metadata()
    if (emulator.grpcToken) metadata.set("authorization", `Bearer ${emulator.grpcToken}`)
    const unary = <Request, Response>(method: Unary<Request, Response>, request: Request) =>
      new Promise<Response>((resolve, reject) =>
        method.call(client, request, metadata, (error, response) => (error ? reject(error) : resolve(response))),
      )
    return { client, metadata, unary }
  }

  type Controller = Awaited<ReturnType<typeof openController>>

  const withController = async <A>(emulator: RunningEmulator, use: (controller: Controller) => Promise<A>) => {
    const controller = await openController(emulator)
    try {
      return await use(controller)
    } finally {
      controller.client.close()
    }
  }

  const mainDisplay = async ({ client, unary }: Controller) => {
    const { displays } = await unary(client.getDisplayConfigurations, {})
    const display = displays.find((candidate) => candidate.display === 0) ?? displays[0]
    if (!display) throw new DeviceError("The emulator reports no display.")
    return { width: display.width, height: display.height, scale: display.dpi / 160 }
  }

  /**
   * Starts the AVD headless. Devices HinaCode boots keep running after it quits, like ones booted from Android
   * Studio: a cold boot costs a minute, and the next session or the user's own tools pick the emulator back up.
   */
  const startEmulator = async (name: string) => {
    const grpcPort = await freePort(FIRST_GRPC_PORT)
    // A headless Linux daemon usually has no GPU, so it renders in software there.
    const gpu = process.platform === "darwin" ? "host" : "swiftshader_indirect"
    const child = spawn(
      emulatorBinary,
      [
        "-avd",
        name,
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
        "-grpc",
        String(grpcPort),
        "-grpc-use-token",
        "-gpu",
        gpu,
      ],
      { detached: true, stdio: "ignore" },
    )
    const exit = { code: null as number | null }
    child.once("exit", (code, signal) => (exit.code = code ?? (signal ? 1 : 0)))
    await once(child, "spawn")
    child.unref()
    return exit
  }

  const support = async (): Promise<PlatformSupport> =>
    (await exists(emulatorBinary)) && (await exists(adbBinary))
      ? { kind: "ready" }
      : { kind: "missing", tool: "androidSdk" }

  const list = async (): Promise<ReadonlyArray<Device>> => {
    const [output, live] = await Promise.all([run(emulatorBinary, ["-list-avds"]), running()])
    const names = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => AVD_NAME.test(line))
    return Promise.all(
      names.map(async (name): Promise<Device> => {
        const emulator = live.get(name)
        const [config, booted] = await Promise.all([avdConfig(name), emulator ? bootCompleted(emulator) : false])
        return {
          id: `android:${name}`,
          platform: "android",
          name: config.get("avd.ini.displayname") || name.replaceAll("_", " "),
          osVersion: androidVersionOf(config.get("image.sysdir.1")),
          state: booted ? "booted" : emulator ? "booting" : "shutdown",
          slim: null,
          memoryBytes: emulator && booted ? await memoryOf(emulator.pid) : null,
          ownerThreadId: null,
        }
      }),
    )
  }

  const boot: DevicePlatformDriver["boot"] = async (id, onStep) => {
    const name = avdNameOf(id)
    const existing = (await running()).get(name)
    if (existing && (await bootCompleted(existing))) return
    onStep("booting")
    const exit = existing ? null : await startEmulator(name)
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exit?.code != null) throw new DeviceError(`The emulator exited with code ${exit.code} while booting.`)
      const emulator = (await running()).get(name)
      if (emulator && (await bootCompleted(emulator))) return
      await sleep(1000)
    }
    throw new DeviceError("The emulator did not finish booting within 4 minutes.")
  }

  const connect: DevicePlatformDriver["connect"] = async (id, onFrame) => {
    const emulator = await runningEmulator(id)
    const controller = await openController(emulator)
    const { client, metadata, unary } = controller
    const display = await mainDisplay(controller).catch((error: unknown) => {
      client.close()
      throw error
    })
    const panel = { width: display.width, height: display.height }
    const box = Math.round(
      (FRAME_SHORT_SIDE * Math.max(panel.width, panel.height)) / Math.min(panel.width, panel.height),
    )
    let rotation: SkinRotation = "PORTRAIT"
    let closed = false
    let stream: grpc.ClientReadableStream<Image> | null = null

    const ended = new Promise<string>((resolve) => {
      let failures = 0
      const start = () => {
        if (closed) return
        // A square box keeps the short side at FRAME_SHORT_SIDE in either orientation; the emulator fits the aspect.
        const current = client.streamScreenshot({ format: "PNG", width: box, height: box }, metadata)
        stream = current
        let done = false
        const restart = (error?: grpc.ServiceError) => {
          if (closed || done) return
          done = true
          if (!isAlive(emulator.pid)) return resolve("The emulator shut down.")
          if (++failures > MAX_STREAM_RESTARTS)
            return resolve(`The emulator stopped sending its screen${error ? `: ${error.details}` : "."}`)
          setTimeout(start, 500)
        }
        current.on("data", (image: Image) => {
          const { width, height } = image.format
          if (width === 0 || image.image.length === 0) return
          failures = 0
          rotation = image.format.rotation?.rotation ?? "PORTRAIT"
          onFrame({
            mime: "image/png",
            data: image.image,
            width,
            height,
            orientation: width > height ? "landscape" : "portrait",
          })
        })
        current.on("error", restart)
        current.on("end", () => restart())
      }
      start()
    })

    const displayPoint = (x: number, y: number) => {
      const landscape = rotation === "LANDSCAPE" || rotation === "REVERSE_LANDSCAPE"
      const width = landscape ? panel.height : panel.width
      const height = landscape ? panel.width : panel.height
      return { x: Math.round(x * width), y: Math.round(y * height) }
    }

    // The emulator's gRPC keyboard reaches the guest only when the AVD has `hw.keyboard=yes`, which `avdmanager`
    // does not set, so keys, text and buttons go through `adb shell input`. Touch stays on gRPC for latency.
    const heldModifiers = new Set<number>()
    let pressedKeys: Array<number> = []
    const flushKeys = async () => {
      if (pressedKeys.length === 0) return
      const keys = pressedKeys
      pressedKeys = []
      await shell(emulator, "input", "keyevent", ...keys.map(String))
    }

    let pendingScroll: { x: number; y: number; deltaX: number; deltaY: number } | null = null
    let scrolling = false
    const flushScroll = async () => {
      if (scrolling) return
      scrolling = true
      try {
        while (pendingScroll) {
          const { x, y, deltaX, deltaY } = pendingScroll
          pendingScroll = null
          const point = displayPoint(x, y)
          const axes = [
            `VSCROLL,${(-deltaY / PIXELS_PER_SCROLL_UNIT).toFixed(2)}`,
            `HSCROLL,${(deltaX / PIXELS_PER_SCROLL_UNIT).toFixed(2)}`,
          ]
          await shell(
            emulator,
            "input",
            "mouse",
            "scroll",
            String(point.x),
            String(point.y),
            ...axes.flatMap((axis) => ["--axis", axis]),
          ).catch(() => undefined)
        }
      } finally {
        scrolling = false
      }
    }

    const typeText = async (text: string) => {
      if (/^[\x20-\x7e\n]*$/.test(text)) {
        const lines = text.split("\n")
        for (const [index, line] of lines.entries()) {
          if (index > 0) await shell(emulator, "input", "keyevent", String(KEYCODE_ENTER))
          // `input text` reads `%s` as a space and splits on real ones.
          if (line) await shell(emulator, "input", "text", quoteForRemoteShell(line.replaceAll(" ", "%s")))
        }
        return
      }
      // `input text` drops anything outside ASCII, so the rest goes through the clipboard.
      await unary(client.setClipboard, { text })
      await shell(emulator, "input", "keyevent", String(KEYCODE_PASTE))
    }

    const apply = async (command: DeviceCommand) => {
      if (command.kind === "key") {
        const modifier = MODIFIER_KEYCODES.get(command.code)
        if (modifier !== undefined) {
          if (command.phase === "down") heldModifiers.add(modifier)
          else heldModifiers.delete(modifier)
          return
        }
        const keycode = KEYCODES.get(command.code)
        if (keycode === undefined || command.phase === "up") return
        if (heldModifiers.size === 0) return void pressedKeys.push(keycode)
        await flushKeys()
        await shell(emulator, "input", "keycombination", ...[...heldModifiers].map(String), String(keycode))
        return
      }
      await flushKeys()
      switch (command.kind) {
        case "touch":
          await unary(client.sendTouch, {
            touches: [
              { ...panelPoint(rotation, command, panel), identifier: 0, pressure: command.phase === "up" ? 0 : 1 },
            ],
          })
          return
        case "scroll":
          pendingScroll = {
            x: command.x,
            y: command.y,
            deltaX: (pendingScroll?.deltaX ?? 0) + command.deltaX,
            deltaY: (pendingScroll?.deltaY ?? 0) + command.deltaY,
          }
          void flushScroll()
          return
        case "text":
          await typeText(command.text)
          return
        case "button":
          await shell(emulator, "input", "keyevent", String(BUTTON_KEYCODES[command.button]))
          return
        case "rotate": {
          const { value } = await unary(client.getPhysicalModel, { target: "ROTATION" })
          const landscape = Math.abs(value?.data[2] ?? 0) > 45
          // Landscape is Android's ROTATION_90, the device's top turned to the left, which DeviceFrame draws.
          await unary(client.setPhysicalModel, { target: "ROTATION", value: { data: [0, 0, landscape ? 0 : 90] } })
          return
        }
        case "appearance":
          await shell(emulator, "cmd", "uimode", "night", command.mode === "dark" ? "yes" : "no")
          return
        case "openUrl": {
          const output = await adb(emulator, [
            "shell",
            "am",
            "start",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            quoteForRemoteShell(command.url),
          ])
          if (output.includes("Error:")) throw new DeviceError(output.trim())
          return
        }
      }
    }

    let queue = Promise.resolve()
    const link: DeviceLink = {
      screen: { width: panel.width / display.scale, height: panel.height / display.scale, scale: display.scale },
      send: (commands) => {
        const next = queue.then(async () => {
          for (const command of commands) await apply(command)
          await flushKeys()
        })
        queue = next.catch(() => undefined)
        return next
      },
      ended,
      close: async () => {
        closed = true
        stream?.cancel()
        client.close()
      },
    }
    return link
  }

  const screenshot: DevicePlatformDriver["screenshot"] = async (id) =>
    withController(await runningEmulator(id), async ({ client, unary }) => {
      const image = await unary(client.getScreenshot, { format: "PNG", width: 0, height: 0 })
      if (image.format.width === 0) throw new DeviceError("The emulator's screen is off.")
      return image.image
    })

  const describe: DevicePlatformDriver["describe"] = async (id) => {
    const emulator = await runningEmulator(id)
    const [{ scale }, dump] = await Promise.all([
      withController(emulator, mainDisplay),
      adb(emulator, ["exec-out", "uiautomator", "dump", "/dev/tty"]),
    ])
    const xml = /<\?xml[\s\S]*<\/hierarchy>/.exec(dump)?.[0]
    if (!xml) throw new DeviceError(dump.trim() || "uiautomator returned no hierarchy.")
    return parseUiHierarchy(xml, scale)
  }

  const launch: DevicePlatformDriver["launch"] = async (id, app) => {
    if (!PACKAGE_NAME.test(app)) throw new DeviceError(`"${app}" is not an Android package name.`)
    const emulator = await runningEmulator(id)
    // `monkey -c LAUNCHER` aborts on images without hardware keys, so resolve the launcher activity instead.
    const resolved = await adb(emulator, [
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-c",
      "android.intent.category.LAUNCHER",
      app,
    ])
    const component = resolved.trim().split(/\r?\n/).at(-1) ?? ""
    if (!/^[\w.$]+\/[\w.$]+$/.test(component))
      throw new DeviceError(`${app} is not installed or has no launcher activity.`)
    await shell(emulator, "am", "start", "-n", quoteForRemoteShell(component))
  }

  return { support, list, boot, create: refuseCreate, remove: refuseCreate, connect, screenshot, describe, launch }
}
