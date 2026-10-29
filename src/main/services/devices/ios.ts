import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { access, constants, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import type {
  Device,
  DeviceButton,
  DeviceCommand,
  DeviceElement,
  DeviceId,
  DeviceScreen,
  SimulatorModel,
} from "../../../shared/device.ts"
import { findBinary } from "../../agents/binary.ts"
import { hidUsage, keystrokesFor } from "./hidUsage.ts"
import { DeviceError, type DeviceLink, type DevicePlatformDriver, type Frame } from "./platform.ts"

export interface SimhelperSources {
  readonly "main.swift": string
  readonly "hid.swift": string
}

export interface IosDriverOptions {
  /** Where the compiled helper is cached, one directory per source hash. */
  readonly cacheDir: string
  readonly sources: SimhelperSources
  readonly simslimPath?: string
}

const FRAME_QUALITY = 0.7
const FRAME_MAX_WIDTH = 600
const SCROLL_IDLE_MS = 120
const INPUT_SPACING_MS = 16
/** Shorter presses are sometimes taken for nothing by table cells. */
const MIN_PRESS_MS = 60
/** Above the helper's worst case: four HID attempts of a 4 s reply wait and a 4 s pause each. */
const HELPER_READY_TIMEOUT_MS = 40_000
/** Matches the rpc's frame limit; anything larger means the stream lost its framing. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

/** UIDeviceOrientation. Landscape is landscapeLeft, the device's top turned to the left, as the device frame draws it. */
const PORTRAIT = 1
const LANDSCAPE_LEFT = 3

/** HID Consumer page usages, which is how the simulator's HID daemon names hardware buttons. */
const buttonUsages: Partial<Record<DeviceButton, number>> = {
  home: 0x40,
  lock: 0x30,
  volumeUp: 0xe9,
  volumeDown: 0xea,
}
const LEFT_SHIFT = 0xe1

const run = (command: string, args: ReadonlyArray<string>, timeout = 60_000): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    })
    const stdout: Array<Buffer> = []
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("error", (error) => reject(new DeviceError(`${command} failed: ${error.message}`)))
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout))
      const reason = lastLine(stderr) || `exited with code ${code}`
      reject(new DeviceError(`${[command, ...args.slice(0, 2)].join(" ")}: ${reason}`))
    })
  })

const simctl = (args: ReadonlyArray<string>, timeout?: number) => run("xcrun", ["simctl", ...args], timeout)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? ""

const udidOf = (id: DeviceId) => id.slice("ios:".length)

const isExecutable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  )

const findSimslim = async (simslimPath?: string): Promise<string | undefined> => {
  for (const path of [simslimPath, join(homedir(), ".local/bin/simslim")]) {
    if (path && (await isExecutable(path))) return path
  }
  return findBinary("simslim")
}

export const simslimAvailable = async (simslimPath?: string): Promise<boolean> =>
  (await findSimslim(simslimPath)) !== undefined

const findAxe = async () =>
  (await isExecutable("/opt/homebrew/bin/axe")) ? "/opt/homebrew/bin/axe" : findBinary("axe")

const SimctlDevices = Schema.fromJsonString(
  Schema.Struct({
    devices: Schema.Record(
      Schema.String,
      Schema.Array(
        Schema.Struct({ udid: Schema.String, name: Schema.String, state: Schema.String, isAvailable: Schema.Boolean }),
      ),
    ),
  }),
)

const SimctlRuntimes = Schema.fromJsonString(
  Schema.Struct({
    runtimes: Schema.Array(
      Schema.Struct({
        identifier: Schema.String,
        version: Schema.String,
        isAvailable: Schema.Boolean,
        platform: Schema.optional(Schema.String),
        supportedDeviceTypes: Schema.optional(
          Schema.Array(
            Schema.Struct({
              identifier: Schema.String,
              name: Schema.String,
              productFamily: Schema.optional(Schema.String),
            }),
          ),
        ),
      }),
    ),
  }),
)

const SimslimList = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      udid: Schema.String,
      managedDisabled: Schema.optional(Schema.Number),
      managedTotal: Schema.optional(Schema.Number),
      memory: Schema.optional(Schema.Struct({ bytes: Schema.Number })),
    }),
  ),
)

const AxeNode = Schema.Struct({
  role: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  AXLabel: Schema.optional(Schema.NullOr(Schema.String)),
  AXUniqueId: Schema.optional(Schema.NullOr(Schema.String)),
  AXValue: Schema.optional(Schema.Unknown),
  frame: Schema.optional(
    Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }),
  ),
  children: Schema.optional(Schema.Array(Schema.Unknown)),
})
const decodeAxeNode = Schema.decodeUnknownSync(AxeNode)

const decode = <A>(schema: Schema.Decoder<A>, text: Buffer, what: string): A => {
  try {
    return Schema.decodeUnknownSync(schema)(text.toString())
  } catch {
    throw new DeviceError(`Unexpected output from ${what}.`)
  }
}

const deviceState = (state: string): Device["state"] =>
  state === "Booted" ? "booted" : state === "Booting" ? "booting" : "shutdown"

/** `com.apple.CoreSimulator.SimRuntime.iOS-27-0` -> `27.0`, or null for another platform. */
const iosVersionOf = (runtime: string) => /\.iOS-([\d-]+)$/.exec(runtime)?.[1]?.replaceAll("-", ".") ?? null

const compareVersions = (a: string, b: string) => {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** The newest plain "iPhone NN", which boots lighter than a Pro, else the first iPhone listed. */
const pickIphone = (models: ReadonlyArray<SimulatorModel>) => {
  const iphones = models.filter((model) => model.name.startsWith("iPhone"))
  const numbered = iphones
    .map((model) => ({ model, number: Number(/^iPhone (\d+)$/.exec(model.name)?.[1]) }))
    .filter(({ number }) => Number.isFinite(number))
    .toSorted((a, b) => b.number - a.number)
  return numbered[0]?.model ?? iphones[0]
}

/** Every device type an installed iOS runtime runs, each on the newest runtime that runs it, newest first. */
const models = async (): Promise<ReadonlyArray<SimulatorModel>> => {
  const { runtimes } = decode(SimctlRuntimes, await simctl(["list", "runtimes", "--json"]), "simctl list runtimes")
  const byDeviceType = new Map<string, SimulatorModel>()
  for (const runtime of runtimes
    .filter((candidate) => candidate.isAvailable && candidate.platform === "iOS")
    .toSorted((a, b) => compareVersions(b.version, a.version))) {
    for (const type of runtime.supportedDeviceTypes ?? []) {
      if (byDeviceType.has(type.identifier)) continue
      byDeviceType.set(type.identifier, {
        deviceType: type.identifier,
        runtime: runtime.identifier,
        name: type.name,
        family: type.productFamily ?? "",
        osVersion: runtime.version,
      })
    }
  }
  return [...byDeviceType.values()]
}

const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text)

const flattenAxe = (nodes: ReadonlyArray<unknown>, into: Array<DeviceElement> = []): Array<DeviceElement> => {
  for (const raw of nodes) {
    const node = decodeAxeNode(raw)
    const role = node.role ?? node.type ?? ""
    const label = node.AXLabel ?? ""
    const identifier = node.AXUniqueId ?? ""
    const value = node.AXValue === null || node.AXValue === undefined ? "" : String(node.AXValue)
    const empty = role === "AXGroup" && !label && !identifier && !value
    if (node.frame && !empty) {
      into.push({
        role: truncate(role, 100),
        label: truncate(label, 500),
        identifier: truncate(identifier, 500),
        value: truncate(value, 500),
        frame: node.frame,
      })
    }
    flattenAxe(node.children ?? [], into)
  }
  return into
}

const sourceHash = (sources: SimhelperSources) =>
  createHash("sha256").update(JSON.stringify(sources)).digest("hex").slice(0, 16)

/**
 * Splits the helper's stdout into frames: a u32 length, then width u16, height u16, orientation u8 and the JPEG.
 * Calls `onCorrupt` once and stops reading when a length cannot be a frame.
 */
const frameReader = (onFrame: (frame: Frame) => void, onCorrupt: () => void) => {
  let pending: Buffer = Buffer.alloc(0)
  let corrupt = false
  return (chunk: Buffer) => {
    if (corrupt) return
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0)
      if (length < 5 || length > MAX_FRAME_BYTES) {
        corrupt = true
        pending = Buffer.alloc(0)
        return onCorrupt()
      }
      if (pending.length < 4 + length) return
      const orientation = pending.readUInt8(8)
      onFrame({
        mime: "image/jpeg",
        width: pending.readUInt16BE(4),
        height: pending.readUInt16BE(6),
        orientation: orientation >= 3 ? "landscape" : "portrait",
        data: pending.subarray(9, 4 + length),
      })
      pending = pending.subarray(4 + length)
    }
  }
}

export const makeIosDriver = (options: IosDriverOptions): DevicePlatformDriver => {
  let developerDir: Promise<string> | undefined
  let helper: Promise<string> | undefined

  /** Asked once; a failure is asked again, in case Xcode was installed meanwhile. */
  const xcodeDeveloperDir = () =>
    (developerDir ??= run("xcode-select", ["-p"]).then(
      (stdout) => stdout.toString().trim(),
      (error: unknown) => {
        developerDir = undefined
        throw error
      },
    ))

  const compileHelper = async () => {
    const dir = join(options.cacheDir, `simhelper-${sourceHash(options.sources)}`)
    const binary = join(dir, "simhelper")
    if (await isExecutable(binary)) return binary
    await mkdir(dir, { recursive: true })
    await Promise.all(Object.entries(options.sources).map(([name, text]) => writeFile(join(dir, name), text)))
    const output = join(dir, `simhelper-${randomUUID()}`)
    await run(
      "xcrun",
      ["swiftc", "-O", "-swift-version", "5", join(dir, "main.swift"), join(dir, "hid.swift"), "-o", output],
      300_000,
    )
    await rename(output, binary)
    return binary
  }

  /** One compile at a time; a failed one is retried on the next connect. */
  const helperBinary = () => {
    helper ??= compileHelper().catch((error: unknown) => {
      helper = undefined
      throw error
    })
    return helper
  }

  const connect = async (id: DeviceId, onFrame: (frame: Frame) => void): Promise<DeviceLink> => {
    const udid = udidOf(id)
    const binary = await helperBinary()
    const child = spawn(binary, [udid, await xcodeDeveloperDir(), String(FRAME_QUALITY), String(FRAME_MAX_WIDTH)], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdin.on("error", () => {})
    child.stdout.on(
      "data",
      frameReader(onFrame, () => child.kill()),
    )
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)))

    const ended = new Promise<string>((resolve) => {
      child.on("error", (error) => resolve(`simhelper failed: ${error.message}`))
      child.on("exit", (code, signal) => resolve(lastLine(stderr) || `simhelper exited (${signal ?? code})`))
    })
    const screen = await new Promise<DeviceScreen>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new DeviceError("The simulator screen did not start.")),
        HELPER_READY_TIMEOUT_MS,
      )
      const onData = () => {
        const ready = /^ready (\S+) (\S+) (\S+)$/m.exec(stderr)
        if (!ready) return
        clearTimeout(timer)
        child.stderr.off("data", onData)
        stderr = stderr.slice(ready.index + ready[0].length)
        resolve({ width: Number(ready[1]), height: Number(ready[2]), scale: Number(ready[3]) })
      }
      child.stderr.on("data", onData)
      void ended.then((reason) => {
        clearTimeout(timer)
        reject(new DeviceError(reason))
      })
    }).catch((error: unknown) => {
      child.kill()
      throw error
    })

    // dtuhidd stamps events as they arrive, so a down and up written together read as a press of no length,
    // which UIKit ignores. Spacing them like a finger keeps taps, key presses and drags real.
    let lastInput = 0
    let lastTouchDown = 0
    let closed = false
    const input = async (...lines: ReadonlyArray<string>) => {
      for (const line of lines) {
        if (closed) throw new DeviceError("The simulator screen was closed.")
        const lift = line.startsWith("touch up")
        const wait = Math.max(lastInput + INPUT_SPACING_MS, lift ? lastTouchDown + MIN_PRESS_MS : 0) - performance.now()
        if (wait > 0) await sleep(wait)
        child.stdin.write(`${line}\n`)
        lastInput = performance.now()
        if (line.startsWith("touch down")) lastTouchDown = lastInput
      }
    }
    let orientation = PORTRAIT
    const shownPoints = () =>
      orientation === PORTRAIT
        ? { width: screen.width, height: screen.height }
        : { width: screen.height, height: screen.width }

    // Wheel ticks from one gesture become one drag, so a scroll view sees a finger rather than taps.
    let scroll: { x: number; y: number; timer?: NodeJS.Timeout } | null = null
    const endScroll = async () => {
      if (!scroll) return
      clearTimeout(scroll.timer)
      const { x, y } = scroll
      scroll = null
      await input(`touch up ${x} ${y}`)
    }
    const scrollBy = async (command: Extract<DeviceCommand, { kind: "scroll" }>) => {
      if (!scroll) {
        scroll = { x: command.x, y: command.y }
        await input(`touch down ${command.x} ${command.y}`)
      }
      clearTimeout(scroll.timer)
      const points = shownPoints()
      const target = { x: scroll.x - command.deltaX / points.width, y: scroll.y - command.deltaY / points.height }
      const clamped = { x: Math.min(Math.max(target.x, 0), 1), y: Math.min(Math.max(target.y, 0), 1) }
      scroll.x = clamped.x
      scroll.y = clamped.y
      await input(`touch move ${clamped.x} ${clamped.y}`)
      // At an edge the finger can go no further, so the next tick starts a fresh drag from the pointer.
      if (clamped.x !== target.x || clamped.y !== target.y) await endScroll()
      else scroll.timer = setTimeout(() => void enqueue(endScroll).catch(() => {}), SCROLL_IDLE_MS)
    }

    const apply = async (command: DeviceCommand) => {
      if (command.kind !== "scroll") await endScroll()
      switch (command.kind) {
        case "touch":
          return input(`touch ${command.phase} ${command.x} ${command.y}`)
        case "scroll":
          return scrollBy(command)
        case "key": {
          const usage = hidUsage(command.code)
          return usage === undefined ? undefined : input(`key ${usage} ${command.phase}`)
        }
        case "text": {
          // `simctl pbcopy` leaves the pasteboard empty on the iOS 27 runtime, so text is typed key by key.
          const strokes = keystrokesFor(command.text)
          if (!strokes) throw new DeviceError("The simulator keyboard can only type text on a US layout.")
          for (const { usage, shift } of strokes) {
            const keys = [`key ${usage} down`, `key ${usage} up`]
            await input(...(shift ? [`key ${LEFT_SHIFT} down`, ...keys, `key ${LEFT_SHIFT} up`] : keys))
          }
          return
        }
        case "button": {
          const usage = buttonUsages[command.button]
          return usage === undefined ? undefined : input(`consumer ${usage} down`, `consumer ${usage} up`)
        }
        case "rotate":
          orientation = orientation === PORTRAIT ? LANDSCAPE_LEFT : PORTRAIT
          return input(`rotate ${orientation}`)
        case "appearance":
          await simctl(["ui", udid, "appearance", command.mode])
          return
        case "openUrl":
          await simctl(["openurl", udid, command.url])
          return
      }
    }

    let queue = Promise.resolve()
    const enqueue = (work: () => Promise<void>) => {
      const next = queue.then(work)
      queue = next.catch(() => {})
      return next
    }
    return {
      screen,
      ended,
      send: (commands) =>
        enqueue(async () => {
          for (const command of commands) await apply(command)
        }),
      close: async () => {
        // Queued input stops at its next line, so a long text does not hold the close.
        closed = true
        clearTimeout(scroll?.timer)
        child.stdin.end()
        const timer = setTimeout(() => child.kill("SIGKILL"), 1000)
        await ended
        clearTimeout(timer)
      },
    }
  }

  return {
    support: async () => {
      if (process.platform !== "darwin") return { kind: "unsupported", reason: "notMac" }
      return simctl(["help"]).then(
        () => ({ kind: "ready" }),
        () => ({ kind: "missing", tool: "xcode" }),
      )
    },

    list: async () => {
      const simslim = await findSimslim(options.simslimPath)
      const [devices, slim] = await Promise.all([
        simctl(["list", "devices", "--json"]).then((stdout) => decode(SimctlDevices, stdout, "simctl list")),
        simslim
          ? run(simslim, ["list", "--json"]).then(
              (stdout) => decode(SimslimList, stdout, "simslim list"),
              () => [],
            )
          : [],
      ])
      const slimByUdid = new Map(slim.map((row) => [row.udid, row]))
      return Object.entries(devices.devices).flatMap(([runtime, rows]) => {
        const osVersion = iosVersionOf(runtime)
        if (osVersion === null) return []
        return rows
          .filter((row) => row.isAvailable)
          .map((row): Device => {
            const slimRow = slimByUdid.get(row.udid)
            return {
              id: `ios:${row.udid}`,
              platform: "ios",
              name: row.name,
              osVersion: `iOS ${osVersion}`,
              state: deviceState(row.state),
              slim:
                slimRow?.managedTotal === undefined
                  ? null
                  : { disabled: slimRow.managedDisabled ?? 0, total: slimRow.managedTotal },
              memoryBytes: slimRow?.memory?.bytes ?? null,
              ownerThreadId: null,
            }
          })
      })
    },

    boot: async (id, onStep) => {
      onStep("booting")
      // `-b` boots a shut-down device and returns at once for a booted one.
      await simctl(["bootstatus", udidOf(id), "-b"], 600_000)
    },

    models,

    create: async (name, wanted, onStep, onCreated) => {
      onStep("creating")
      const available = await models()
      const model = wanted
        ? available.find(
            (candidate) => candidate.deviceType === wanted.deviceType && candidate.runtime === wanted.runtime,
          )
        : pickIphone(available)
      if (!model) {
        throw new DeviceError(
          wanted
            ? "This simulator model is no longer installed. Refresh the device list."
            : "No iOS simulator runtime is installed. Add one in Xcode.",
        )
      }
      const udid = (await simctl(["create", name, model.deviceType, model.runtime])).toString().trim()
      const id: DeviceId = `ios:${udid}`
      await onCreated(id)
      const simslim = await findSimslim(options.simslimPath)
      if (simslim) {
        onStep("slimming")
        await run(simslim, ["on", udid], 900_000)
      } else {
        onStep("booting")
        await simctl(["bootstatus", udid, "-b"], 600_000)
      }
      return id
    },

    remove: async (id) => {
      const udid = udidOf(id)
      const simslim = await findSimslim(options.simslimPath)
      if (simslim) {
        await run(simslim, ["delete", udid, "--json"])
        return
      }
      await simctl(["shutdown", udid]).catch(() => {})
      await simctl(["delete", udid])
    },

    connect,

    screenshot: async (id) => {
      const path = join(tmpdir(), `hinacode-screenshot-${randomUUID()}.png`)
      try {
        await simctl(["io", udidOf(id), "screenshot", "--type=png", path])
        return await readFile(path)
      } finally {
        await rm(path, { force: true })
      }
    },

    describe: async (id) => {
      const axe = await findAxe()
      if (!axe) throw new DeviceError("Describing the screen needs AXe: brew install cameroncooke/axe/axe")
      const stdout = await run(axe, ["describe-ui", "--udid", udidOf(id)])
      const tree = decode(Schema.fromJsonString(Schema.Array(Schema.Unknown)), stdout, "axe describe-ui")
      try {
        return flattenAxe(tree)
      } catch {
        throw new DeviceError("Unexpected output from axe describe-ui.")
      }
    },

    launch: async (id, app) => {
      if (!BUNDLE_ID.test(app))
        throw new DeviceError(`${JSON.stringify(app)} is not a bundle id, such as com.example.app.`)
      await simctl(["launch", udidOf(id), app])
    },
  }
}
