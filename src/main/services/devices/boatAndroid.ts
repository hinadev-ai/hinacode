import { createHash } from "node:crypto"
import { Effect } from "effect"
import type {
  Device,
  DeviceCommand,
  DeviceId,
  DeviceScreen,
  PlatformSupport,
  PrepareStep,
} from "../../../shared/device.ts"
import type { BoatClient, BoatSandbox } from "../boat/Boat.ts"
import {
  BUTTON_KEYCODES,
  CREATE_UNSUPPORTED,
  KEYCODES,
  MODIFIER_KEYCODES,
  parseUiHierarchy,
  PIXELS_PER_SCROLL_UNIT,
  quoteForRemoteShell,
} from "./androidParsers.ts"
import { DeviceError, type DevicePlatformDriver } from "./platform.ts"

export const BOAT_DEVICE_ID: DeviceId = "android:boat.cloud"
export const BOAT_DEVICE_PREFIX = "android:boat."

export interface BoatDeviceExecResult {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

export interface BoatDeviceRunner {
  readonly configured: () => Promise<boolean>
  readonly list: () => Promise<ReadonlyArray<BoatSandbox>>
  readonly create: (input: {
    readonly type: string
    readonly name: string
    readonly labels: Readonly<Record<string, string>>
  }) => Promise<{ readonly id: string }>
  readonly resume: (id: string) => Promise<void>
  readonly waitReady: (id: string) => Promise<void>
  readonly remove: (id: string) => Promise<void>
  readonly exec: (id: string, script: string, timeoutSeconds: number) => Promise<BoatDeviceExecResult>
  readonly execDetached: (id: string, script: string) => Promise<void>
  readonly readFile: (id: string, guestPath: string) => Promise<Uint8Array>
}

interface BoatServiceShape {
  readonly client: Effect.Effect<BoatClient, { readonly message: string }>
  readonly configured: Effect.Effect<boolean>
}

export const boatDeviceRunner = (boat: BoatServiceShape): BoatDeviceRunner => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  return {
    configured: () => run(boat.configured),
    list: () => run(Effect.flatMap(boat.client, (client) => client.listAll())),
    create: (input) => run(Effect.flatMap(boat.client, (client) => client.createSandbox(input))),
    resume: (id) => run(Effect.asVoid(Effect.flatMap(boat.client, (client) => client.resume(id)))),
    waitReady: (id) => run(Effect.asVoid(Effect.flatMap(boat.client, (client) => client.waitReady(id)))),
    remove: (id) => run(Effect.flatMap(boat.client, (client) => client.remove(id))),
    exec: (id, script, timeoutSeconds) =>
      run(Effect.flatMap(boat.client, (client) => client.exec(id, { script, timeoutSeconds }))),
    execDetached: async (id, script) => {
      const result = await run(
        Effect.flatMap(boat.client, (client) => client.exec(id, { script, timeoutSeconds: 30, detach: true })),
      )
      if (result.exitCode !== 0)
        throw new Error(`boat refused the background command with exit code ${result.exitCode}`)
    },
    readFile: (id, guestPath) => run(Effect.flatMap(boat.client, (client) => client.readFileBytes(id, guestPath))),
  }
}

const DEVICE_NAME = "Boat Android (cloud)"
const DEVICE_LABEL = "android-device"
const SANDBOX_NAME = "hinacode-android"
const FRAME_WIDTH = 540
const FRAME_PATH = "/tmp/.hinacode-frame.png"
const FRAME_SMALL_PATH = "/tmp/.hinacode-frame-small.png"
const READY_MARKER = "~/.hinacode-android-ready"
const GUEST_ENV = "export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ANDROID_HOME=$HOME/android"
const ADB = "$ANDROID_HOME/platform-tools/adb"
const BOOT_WAIT_TIMEOUT_SECONDS = 300
const INSTALL_TIMEOUT_SECONDS = 600
const MAX_FRAME_FAILURES = 5

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const messageOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "SandboxGoneError"
    ? "Its boat sandbox is gone. Attach the device again to recreate it."
    : cause instanceof Error
      ? cause.message
      : String(cause)
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString()
const tail = (value: string) => value.trim().slice(-500)

const INSTALL_STAGES: ReadonlyArray<string> = [
  [
    "set -e",
    "sudo apt-get update -qq",
    "sudo apt-get install -y -qq openjdk-17-jre-headless unzip imagemagick",
    GUEST_ENV,
    'if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then',
    '  mkdir -p "$ANDROID_HOME/cmdline-tools"',
    "  cd /tmp",
    "  curl -fsSLo clt.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip",
    '  unzip -q -o clt.zip -d "$ANDROID_HOME/cmdline-tools"',
    '  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"',
    "fi",
  ].join("\n"),
  [
    "set -e",
    GUEST_ENV,
    'yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null',
    '"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "emulator" "system-images;android-34;google_apis;x86_64"',
  ].join("\n"),
  [
    "set -e",
    GUEST_ENV,
    "test -e /dev/kvm",
    'echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n phone -k "system-images;android-34;google_apis;x86_64" -d pixel_6 --force',
    `touch ${READY_MARKER}`,
  ].join("\n"),
]

const EMULATOR_START = `${GUEST_ENV}; $ANDROID_HOME/emulator/emulator -avd phone -no-window -no-audio -gpu swiftshader_indirect`
const BOOT_WAIT = `${GUEST_ENV}; ADB=${ADB}; $ADB wait-for-device; for i in $(seq 1 120); do [ "$($ADB shell getprop sys.boot_completed | tr -d '\\r')" = "1" ] && exit 0; sleep 2; done; exit 1`

const pngSize = (png: Uint8Array): { readonly width: number; readonly height: number } | null => {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) return null
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const parseDisplay = (output: string): DeviceScreen => {
  const size = /(\d+)x(\d+)/.exec(output)
  const density = /density:\s*(\d+)/.exec(output)
  if (!size) throw new DeviceError("The boat Android emulator reports no display size.")
  const width = Number(size[1])
  const height = Number(size[2])
  const scale = (density ? Number(density[1]) : 420) / 160
  return { width: width / scale, height: height / scale, scale }
}

export const makeBoatAndroidDriver = (runner: BoatDeviceRunner): DevicePlatformDriver => {
  let sandboxId: string | undefined
  const booting = new Map<string, Promise<void>>()

  const attempt = async <A>(work: () => Promise<A>): Promise<A> => {
    try {
      return await work()
    } catch (cause) {
      throw cause instanceof DeviceError ? cause : new DeviceError(messageOf(cause))
    }
  }

  const findSandbox = async (): Promise<BoatSandbox | undefined> => {
    const all = await attempt(() => runner.list())
    const found = all.find((sandbox) => sandbox.labels["hinacode-kind"] === DEVICE_LABEL)
    if (found) sandboxId = found.id
    return found
  }

  const requireSandboxId = async (): Promise<string> => {
    if (sandboxId !== undefined) return sandboxId
    const found = await findSandbox()
    if (found === undefined)
      throw new DeviceError("The boat Android sandbox does not exist yet. Boot the device first.")
    return found.id
  }

  const exec = (script: string, timeoutSeconds = 120) =>
    attempt(async () => runner.exec(await requireSandboxId(), script, timeoutSeconds))

  const adb = (args: string, timeoutSeconds = 120) => exec(`${GUEST_ENV}; ${ADB} ${args}`, timeoutSeconds)

  const bootCompleted = async (): Promise<boolean> => {
    try {
      const result = await adb("shell getprop sys.boot_completed", 30)
      return result.exitCode === 0 && text(result.stdout).trim() === "1"
    } catch {
      return false
    }
  }

  const ensureInstalled = async () => {
    const marker = await exec(`test -f ${READY_MARKER} && echo ready`, 30)
    if (text(marker.stdout).includes("ready")) return
    for (const stage of INSTALL_STAGES) {
      const result = await exec(stage, INSTALL_TIMEOUT_SECONDS)
      if (result.exitCode !== 0)
        throw new DeviceError(
          `Installing Android in the boat sandbox failed with exit code ${result.exitCode}: ${tail(text(result.stderr))}`,
        )
    }
  }

  const bootOnce = async (onStep: (step: PrepareStep) => void) => {
    const existing = await findSandbox()
    if (existing === undefined) {
      onStep("creating")
      const created = await attempt(() =>
        runner.create({ type: "large", name: SANDBOX_NAME, labels: { "hinacode-kind": DEVICE_LABEL } }),
      )
      sandboxId = created.id
    } else if (existing.state === "archived" || existing.state === "archiving") {
      onStep("creating")
      await attempt(() => runner.resume(existing.id))
    } else if (existing.state !== "ready" && existing.state !== "idle" && existing.state !== "running") {
      onStep("creating")
      await attempt(() => runner.waitReady(existing.id))
    }
    if (await bootCompleted()) return
    onStep("booting")
    await ensureInstalled()
    await attempt(async () => runner.execDetached(await requireSandboxId(), EMULATOR_START))
    const waited = await exec(BOOT_WAIT, BOOT_WAIT_TIMEOUT_SECONDS)
    if (waited.exitCode !== 0) throw new DeviceError("The Android emulator in the boat sandbox did not finish booting.")
  }

  const boot: DevicePlatformDriver["boot"] = (_id, onStep) => {
    const running = booting.get(BOAT_DEVICE_ID)
    if (running) {
      onStep("booting")
      return running
    }
    const run = bootOnce(onStep).finally(() => booting.delete(BOAT_DEVICE_ID))
    booting.set(BOAT_DEVICE_ID, run)
    return run
  }

  const displayInfo = async (): Promise<{
    readonly screen: DeviceScreen
    readonly panel: { width: number; height: number }
  }> => {
    const result = await exec(`${GUEST_ENV}\n${ADB} shell wm size\n${ADB} shell wm density`, 30)
    const screen = parseDisplay(text(result.stdout))
    return {
      screen,
      panel: { width: Math.round(screen.width * screen.scale), height: Math.round(screen.height * screen.scale) },
    }
  }

  const capture = async (small: boolean): Promise<Buffer> => {
    const script = small
      ? `${GUEST_ENV}; ${ADB} exec-out screencap -p > ${FRAME_PATH} && convert ${FRAME_PATH} -resize ${FRAME_WIDTH}x ${FRAME_SMALL_PATH}`
      : `${GUEST_ENV}; ${ADB} exec-out screencap -p > ${FRAME_PATH}`
    const result = await exec(script, 60)
    if (result.exitCode !== 0)
      throw new DeviceError(`Taking a screenshot in the boat sandbox failed: ${tail(text(result.stderr))}`)
    return Buffer.from(
      await attempt(async () => runner.readFile(await requireSandboxId(), small ? FRAME_SMALL_PATH : FRAME_PATH)),
    )
  }

  return {
    support: async (): Promise<PlatformSupport> =>
      (await runner.configured().catch(() => false)) ? { kind: "ready" } : { kind: "missing", tool: "androidSdk" },
    list: async (): Promise<ReadonlyArray<Device>> => {
      if (!(await runner.configured().catch(() => false))) return []
      const sandbox = await findSandbox().catch(() => undefined)
      const running =
        sandbox !== undefined && (sandbox.state === "ready" || sandbox.state === "idle" || sandbox.state === "running")
      const booted = running ? await bootCompleted() : false
      return [
        {
          id: BOAT_DEVICE_ID,
          platform: "android",
          name: DEVICE_NAME,
          osVersion: "Android 14",
          state: booted ? "booted" : running ? "booting" : "shutdown",
          slim: null,
          memoryBytes: null,
          ownerThreadId: null,
        },
      ]
    },
    models: async () => [],
    boot,
    create: () => Promise.reject(new DeviceError(CREATE_UNSUPPORTED)),
    remove: async () => {
      const found = await findSandbox().catch(() => undefined)
      sandboxId = undefined
      if (found) await attempt(() => runner.remove(found.id))
    },
    connect: async (_id, onFrame) => {
      await requireSandboxId()
      if (!(await bootCompleted())) throw new DeviceError("The Android emulator in the boat sandbox is not running.")
      const { screen, panel } = await displayInfo()
      let closed = false
      let lastHash = ""
      let resolveEnded: (reason: string) => void = () => undefined
      const ended = new Promise<string>((resolve) => (resolveEnded = resolve))
      let frameLandscape = false

      const loop = async () => {
        let failures = 0
        while (!closed) {
          try {
            const png = await capture(true)
            failures = 0
            const hash = createHash("sha1").update(png).digest("hex")
            if (hash === lastHash) {
              await sleep(500)
              continue
            }
            lastHash = hash
            const size = pngSize(png) ?? {
              width: FRAME_WIDTH,
              height: Math.round((FRAME_WIDTH * panel.height) / panel.width),
            }
            frameLandscape = size.width > size.height
            onFrame({
              mime: "image/png",
              data: png,
              width: size.width,
              height: size.height,
              orientation: frameLandscape ? "landscape" : "portrait",
            })
          } catch (cause) {
            if (closed) return
            failures += 1
            if (failures > MAX_FRAME_FAILURES) {
              resolveEnded(`The boat Android device stopped sending its screen: ${messageOf(cause)}`)
              return
            }
            await sleep(1000)
          }
        }
      }
      void loop()

      const heldModifiers = new Set<number>()
      const point = (x: number, y: number) => {
        const width = frameLandscape ? Math.max(panel.width, panel.height) : Math.min(panel.width, panel.height)
        const height = frameLandscape ? Math.min(panel.width, panel.height) : Math.max(panel.width, panel.height)
        return { x: Math.round(x * width), y: Math.round(y * height) }
      }

      const linesFor = (command: DeviceCommand, pendingKeys: Array<number>): ReadonlyArray<string> => {
        switch (command.kind) {
          case "touch": {
            const at = point(command.x, command.y)
            const phase = command.phase === "down" ? "DOWN" : command.phase === "move" ? "MOVE" : "UP"
            return [`input motionevent ${phase} ${at.x} ${at.y}`]
          }
          case "scroll": {
            const at = point(command.x, command.y)
            return [
              `input mouse scroll ${at.x} ${at.y} --axis VSCROLL,${(-command.deltaY / PIXELS_PER_SCROLL_UNIT).toFixed(2)} --axis HSCROLL,${(command.deltaX / PIXELS_PER_SCROLL_UNIT).toFixed(2)}`,
            ]
          }
          case "key": {
            const modifier = MODIFIER_KEYCODES.get(command.code)
            if (modifier !== undefined) {
              if (command.phase === "down") heldModifiers.add(modifier)
              else heldModifiers.delete(modifier)
              return []
            }
            const keycode = KEYCODES.get(command.code)
            if (keycode === undefined || command.phase === "up") return []
            if (heldModifiers.size === 0) {
              pendingKeys.push(keycode)
              return []
            }
            return [`input keycombination ${[...heldModifiers].map(String).join(" ")} ${keycode}`]
          }
          case "text": {
            if (/^[\x20-\x24\x26-\x7e\n]*$/.test(command.text)) {
              return command.text
                .split("\n")
                .flatMap((line, index) => [
                  ...(index > 0 ? [`input keyevent 66`] : []),
                  ...(line ? [`input text ${quoteForRemoteShell(line.replaceAll(" ", "%s"))}`] : []),
                ])
            }
            throw new DeviceError("Typing non-ASCII text is not supported on the boat Android device yet.")
          }
          case "button":
            return [`input keyevent ${BUTTON_KEYCODES[command.button]}`]
          case "rotate":
            return [
              "settings put system accelerometer_rotation 0",
              `settings put system user_rotation ${frameLandscape ? 0 : 1}`,
            ]
          case "appearance":
            return [`cmd uimode night ${command.mode === "dark" ? "yes" : "no"}`]
          case "openUrl":
            return [`am start -a android.intent.action.VIEW -d ${quoteForRemoteShell(command.url)}`]
          case "posture":
            throw new DeviceError("Postures are only for foldable iOS simulators.")
        }
      }

      let queue = Promise.resolve()
      return {
        screen,
        send: (commands) => {
          const next = queue.then(async () => {
            if (closed) throw new DeviceError("The boat Android screen was closed.")
            const pendingKeys: Array<number> = []
            const lines: Array<string> = []
            for (const command of commands) lines.push(...linesFor(command, pendingKeys))
            if (pendingKeys.length > 0) lines.push(`input keyevent ${pendingKeys.map(String).join(" ")}`)
            if (lines.length === 0) return
            const script = [GUEST_ENV, ...lines.map((line) => `${ADB} shell ${shellQuote(line)}`)].join("\n")
            const result = await exec(script, 60)
            const output = text(result.stdout)
            if (output.includes("Error:")) throw new DeviceError(output.trim())
            if (result.exitCode !== 0)
              throw new DeviceError(`Sending input to the boat Android device failed: ${tail(text(result.stderr))}`)
          })
          queue = next.catch(() => undefined)
          return next
        },
        ended,
        close: async () => {
          closed = true
        },
      }
    },
    screenshot: async () => capture(false),
    describe: async () => {
      const [{ screen }, dump] = await Promise.all([displayInfo(), adb("exec-out uiautomator dump /dev/tty", 60)])
      const xml = /<\?xml[\s\S]*<\/hierarchy>/.exec(text(dump.stdout))?.[0]
      if (!xml) throw new DeviceError(text(dump.stderr).trim() || "uiautomator returned no hierarchy.")
      return parseUiHierarchy(xml, screen.scale)
    },
    launch: async (_id, app) => {
      if (!/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(app))
        throw new DeviceError(`"${app}" is not an Android package name.`)
      const resolved = await exec(
        `${GUEST_ENV}; ${ADB} shell ${shellQuote(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${app}`)}`,
        30,
      )
      const component = text(resolved.stdout).trim().split(/\r?\n/).at(-1) ?? ""
      if (!/^[\w.$]+\/[\w.$]+$/.test(component))
        throw new DeviceError(`${app} is not installed or has no launcher activity.`)
      await exec(`${GUEST_ENV}; ${ADB} shell ${shellQuote(`am start -n ${component}`)}`, 30)
    },
  }
}

const isBoatDevice = (id: DeviceId) => id.startsWith(BOAT_DEVICE_PREFIX)

export const withBoatAndroid = (local: DevicePlatformDriver, boat: DevicePlatformDriver): DevicePlatformDriver => ({
  support: async () => {
    const [localSupport, boatSupport] = await Promise.all([local.support(), boat.support()])
    return localSupport.kind === "ready" || boatSupport.kind === "ready" ? { kind: "ready" } : localSupport
  },
  list: async () => {
    const [localDevices, boatDevices] = await Promise.all([
      local.list().catch(() => [] as ReadonlyArray<Device>),
      boat.list().catch(() => [] as ReadonlyArray<Device>),
    ])
    return [...localDevices, ...boatDevices]
  },
  models: () => local.models(),
  boot: (id, onStep) => (isBoatDevice(id) ? boat : local).boot(id, onStep),
  create: (...args) => local.create(...args),
  remove: (id) => (isBoatDevice(id) ? boat : local).remove(id),
  connect: (id, onFrame) => (isBoatDevice(id) ? boat : local).connect(id, onFrame),
  screenshot: (id) => (isBoatDevice(id) ? boat : local).screenshot(id),
  describe: (id) => (isBoatDevice(id) ? boat : local).describe(id),
  launch: (id, app) => (isBoatDevice(id) ? boat : local).launch(id, app),
})
