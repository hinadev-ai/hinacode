import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, open, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import { Effect, Schema } from "effect"
import { type McpSchema, Toolkit } from "effect/ai"
import {
  type AgentAction,
  DeviceApp,
  DeviceButton,
  type DeviceCommand,
  type DeviceElement,
  DeviceUrl,
  INSTALL_CHUNK_BYTES,
  type InstallKind,
} from "../../../shared/device.ts"
import { RemoteAccess } from "../../remote/access.ts"
import { Attachments } from "../../services/Attachments.ts"
import { type AgentSteps, Devices } from "../../services/devices/Devices.ts"
import { callHub, deviceHub } from "../../services/devices/hub.ts"
import { Environments } from "../../services/Environments.ts"
import { Settings } from "../../services/Settings.ts"
import * as McpTool from "./tool.ts"

const Point = (what: string) =>
  Schema.Number.annotate({ description: `${what}, in screen points, the unit device_describe_ui reports frames in.` })

const STARTS =
  "Acts on one of the thread's devices; pass `device` when it has more than one. With none attached, creates a slim iOS simulator for the thread."
const WAITS = "While the user has control it waits for them to hand it back and then returns the screen without acting."
const SHOWS = "Returns what `show` asks for, a screenshot by default."
const HANDED_BACK =
  "The user had control and has handed it back. The screen may have changed, so this action was not performed. Look at the screenshot before you continue."
const Target = Schema.optionalKey(
  Schema.String.check(Schema.isMaxLength(200)).annotate({
    description:
      "The device's name or id, as an earlier device tool result shows it. Leave it out while the thread has at most one device.",
  }),
)
const Show = Schema.optionalKey(
  Schema.Literals(["screenshot", "ui", "none"]).annotate({
    description: "What to return after acting: screenshot (default), ui for the device_describe_ui lines, or none.",
  }),
)
type Show = "screenshot" | "ui" | "none"
const SWIPE_STEPS = 12
const SETTLE_MS = 1000
const execFileAsync = promisify(execFile)

export const DeviceTools = Toolkit.make(
  McpTool.make("device_screenshot", {
    description: `Take a screenshot of the thread's iOS simulator or Android emulator. ${STARTS}`,
    parameters: Schema.Struct({
      device: Target,
      save: Schema.optionalKey(
        Schema.Boolean.annotate({
          description: "Also save the image on this machine and return Markdown that embeds it, to show the user.",
        }),
      ),
    }),
  }),
  McpTool.make("device_tap", {
    description: `Tap an element by its label or identifier from device_describe_ui, or a point. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({
      device: Target,
      element: Schema.optionalKey(
        Schema.String.check(Schema.isMaxLength(500)).annotate({
          description: "A label or identifier. Or pass x and y.",
        }),
      ),
      x: Schema.optionalKey(Point("Horizontal position")),
      y: Schema.optionalKey(Point("Vertical position")),
      show: Show,
    }),
  }),
  McpTool.make("device_swipe", {
    description: `Swipe with one finger from one point to another, for example to scroll or go back from the left edge. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({
      device: Target,
      x: Point("Start position"),
      y: Point("Start position"),
      toX: Point("End position"),
      toY: Point("End position"),
      durationMs: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 5000 })).annotate({
          description: "50-5000. Defaults to 300.",
        }),
      ),
      show: Show,
    }),
  }),
  McpTool.make("device_type", {
    description: `Type text into the focused field. Tap the field first. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({
      device: Target,
      text: Schema.String.check(Schema.isMaxLength(10_000)).annotate({ description: "At most 10,000 characters." }),
      show: Show,
    }),
  }),
  McpTool.make("device_button", {
    description: `Press a hardware button. back and recents exist on Android only. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({ device: Target, button: DeviceButton, show: Show }),
  }),
  McpTool.make("device_launch", {
    description: `Launch an installed app by its iOS bundle id or Android package name. ${STARTS} ${SHOWS}`,
    parameters: Schema.Struct({ device: Target, app: DeviceApp, show: Show }),
  }),
  McpTool.make("device_open_url", {
    description: `Open a URL on the device, such as a deep link like myapp://settings or an Expo dev server URL. ${STARTS} ${SHOWS}`,
    parameters: Schema.Struct({
      device: Target,
      url: DeviceUrl.annotate({ description: "A URL with a scheme, such as myapp://settings or https://example.com." }),
      show: Show,
    }),
  }),
  McpTool.make("device_describe_ui", {
    description: `List the accessibility elements on screen, one per line with role, label, identifier, value and frame in points. Cheaper than a screenshot for finding what to tap. ${STARTS}`,
    parameters: Schema.Struct({ device: Target }),
  }),
  McpTool.make("device_install", {
    description: `Install an iOS .app build or an Android .apk on the device and return its bundle id or package name. ${STARTS}`,
    parameters: Schema.Struct({
      device: Target,
      path: Schema.String.check(Schema.isMaxLength(4096)).annotate({
        description: "Absolute path on this machine to a simulator .app directory or an .apk file.",
      }),
    }),
  }),
  McpTool.make("device_logs", {
    description: `Read the device's recent log lines, at most 200, for crashes and console output. ${STARTS}`,
    parameters: Schema.Struct({
      device: Target,
      app: Schema.optionalKey(DeviceApp.annotate({ description: "Only this bundle id or package name's lines." })),
      sinceSeconds: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })).annotate({ description: "Defaults to 60." }),
      ),
    }),
  }),
)

const describeLine = ({ role, label, identifier, value, frame }: DeviceElement) =>
  [
    role,
    label && JSON.stringify(label),
    identifier && `id=${JSON.stringify(identifier)}`,
    value && `value=${JSON.stringify(value)}`,
    `(${Math.round(frame.x)}, ${Math.round(frame.y)}, ${Math.round(frame.width)}×${Math.round(frame.height)})`,
  ]
    .filter(Boolean)
    .join(" ")

const describeLines = (elements: ReadonlyArray<DeviceElement>) =>
  elements.length === 0 ? "No accessibility elements on screen." : elements.map(describeLine).join("\n")

const targetOf = (device: string | undefined) => (device === undefined ? {} : { device })

const toolError = (message: string) => ({ message })
const fromPromise = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (cause) => toolError(cause instanceof Error ? cause.message : String(cause)) })

const installKindOf = (path: string) =>
  fromPromise(async (): Promise<InstallKind> => {
    if (!isAbsolute(path)) throw new Error("Pass an absolute path.")
    const info = await stat(path).catch(() => null)
    if (info?.isFile() && path.endsWith(".apk")) return "apk"
    if (info?.isDirectory() && path.replace(/\/+$/, "").endsWith(".app")) return "app"
    throw new Error(`${path} is not an existing .app directory or .apk file.`)
  })

const packedForUpload = (kind: InstallKind, path: string) =>
  Effect.acquireRelease(
    fromPromise(async () => {
      if (kind === "apk") return { file: path, dir: null }
      const dir = await mkdtemp(join(tmpdir(), "hinacode-install-"))
      const file = join(dir, "app.tar")
      const app = path.replace(/\/+$/, "")
      await execFileAsync("tar", ["-cf", file, "-C", dirname(app), basename(app)], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        timeout: 5 * 60_000,
      })
      return { file, dir }
    }),
    ({ dir }) => Effect.promise(() => (dir === null ? Promise.resolve() : rm(dir, { recursive: true, force: true }))),
  )

const uploadToHub = (hub: string, threadId: string, device: string | undefined, kind: InstallKind, path: string) =>
  Effect.gen(function* () {
    const { file } = yield* packedForUpload(kind, path)
    const handle = yield* Effect.acquireRelease(
      fromPromise(() => open(file)),
      (opened) => Effect.promise(() => opened.close()),
    )
    const bytes = (yield* fromPromise(() => handle.stat())).size
    const { uploadId } = yield* callHub(hub, "device.install.begin", { threadId, ...targetOf(device), kind, bytes })
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(INSTALL_CHUNK_BYTES)
    for (let index = 0; ; index++) {
      const { bytesRead } = yield* fromPromise(() => handle.read(buffer, 0, buffer.length, null))
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      yield* callHub(hub, "device.install.chunk", { threadId, uploadId, index, data: chunk.toString("base64") })
    }
    return yield* callHub(hub, "device.install.end", { threadId, uploadId, sha256: hash.digest("hex") })
  }).pipe(Effect.scoped)

const elementCenter = (elements: ReadonlyArray<DeviceElement>, wanted: string) => {
  const matches = elements.filter(({ label, identifier }) => label === wanted || identifier === wanted)
  const [smallest] = matches.toSorted((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height)
  if (!smallest) return null
  return { x: smallest.frame.x + smallest.frame.width / 2, y: smallest.frame.y + smallest.frame.height / 2 }
}

export const deviceToolsLayer = DeviceTools.toLayer(
  Effect.gen(function* () {
    const devices = yield* Devices
    const attachments = yield* Attachments
    const hubServices = yield* Effect.context<Settings | RemoteAccess | Environments>()

    const local = <A, E>(
      onHub: (hub: string) => Effect.Effect<A, E | { readonly message: string }, RemoteAccess | Environments>,
      here: () => Effect.Effect<A, E | { readonly message: string }>,
    ) =>
      Effect.flatMap(deviceHub, (hub) => (hub === undefined ? here() : onHub(hub))).pipe(
        Effect.provideContext(hubServices),
      )

    const agentDevices = {
      act: (threadId: string, device: string | undefined, action: AgentAction, input: AgentSteps) =>
        local(
          (hub) => callHub(hub, "device.act", { threadId, ...targetOf(device), action, input }),
          () => devices.act(threadId, device, action, input),
        ),
      look: (threadId: string, device: string | undefined) =>
        local(
          (hub) => callHub(hub, "device.look", { threadId, ...targetOf(device) }),
          () =>
            Effect.map(devices.screenshot(threadId, device), ({ frame, state, screen }) => ({
              frame,
              device: state.device,
              screen,
            })),
        ),
      describe: (threadId: string, device: string | undefined) =>
        local(
          (hub) => callHub(hub, "device.describe", { threadId, ...targetOf(device) }),
          () => devices.describe(threadId, device),
        ),
      launch: (threadId: string, device: string | undefined, app: string) =>
        local(
          (hub) => callHub(hub, "device.launch", { threadId, ...targetOf(device), app }),
          () => devices.launch(threadId, device, app),
        ),
      logs: (threadId: string, device: string | undefined, app: string | undefined, sinceSeconds: number) => {
        const input = { threadId, ...targetOf(device), ...(app === undefined ? {} : { app }), sinceSeconds }
        return local(
          (hub) => callHub(hub, "device.logs", input),
          () => devices.logs(input),
        )
      },
      install: (threadId: string, device: string | undefined, path: string) =>
        Effect.flatMap(installKindOf(path), (kind) =>
          local(
            (hub) => uploadToHub(hub, threadId, device, kind, path),
            () => devices.install(threadId, device, path),
          ),
        ),
    }

    const screen = (threadId: string, device: string | undefined, caption: string, save = false) =>
      Effect.gen(function* () {
        const look = yield* agentDevices.look(threadId, device)
        const { frame } = look
        const data = Buffer.from(frame.data, "base64")
        const size = `${Math.round(look.screen.width)}×${Math.round(look.screen.height)} points`
        const about = `${caption} ${look.device.name} (${look.device.id}), ${look.device.osVersion}, screen ${size}${frame.orientation === "landscape" ? " (landscape)" : ""}.`
        const blocks: Array<McpSchema.ContentBlock> = [{ type: "text", text: about }]
        if (save) {
          const { path } = yield* attachments.stage(threadId, {
            dataUrl: `data:${frame.mime};base64,${frame.data}`,
            name: `device-screenshot.${frame.mime === "image/png" ? "png" : "jpg"}`,
          })
          blocks.push({ type: "text", text: `Saved to ${path}. Embed it with: ![Device screenshot](<${path}>)` })
        }
        blocks.push({ type: "image", data, mimeType: frame.mime })
        return blocks
      })

    const shown = (threadId: string, device: string | undefined, show: Show, done: string) => {
      if (show === "screenshot") return screen(threadId, device, `${done} on`)
      if (show === "none") return Effect.succeed(`${done}.`)
      return Effect.map(agentDevices.describe(threadId, device), (elements) => `${done}.\n${describeLines(elements)}`)
    }

    const handedBack = (threadId: string, device: string | undefined, show: Show) =>
      show === "screenshot"
        ? screen(threadId, device, HANDED_BACK)
        : Effect.succeed(HANDED_BACK.replace(" Look at the screenshot before you continue.", ""))

    const at = (threadId: string, device: string | undefined, x: number, y: number) =>
      Effect.map(agentDevices.look(threadId, device), (look) => ({
        x: Math.min(1, Math.max(0, x / look.screen.width)),
        y: Math.min(1, Math.max(0, y / look.screen.height)),
        deviceId: look.device.id,
      }))

    const actAndShow = (
      threadId: string,
      device: string | undefined,
      action: AgentAction,
      input: AgentSteps,
      show: Show,
      done: string,
    ) =>
      Effect.gen(function* () {
        if ((yield* agentDevices.act(threadId, device, action, input)) === "handedBack") {
          return yield* handedBack(threadId, device, show)
        }
        yield* Effect.sleep(SETTLE_MS)
        return yield* shown(threadId, device, show, done)
      })

    const tapPoint = (threadId: string, device: string | undefined, element?: string, x?: number, y?: number) =>
      Effect.gen(function* () {
        if (element !== undefined && x === undefined && y === undefined) {
          const center = elementCenter(yield* agentDevices.describe(threadId, device), element)
          if (center) return { ...center, what: JSON.stringify(element) }
          return yield* Effect.fail(
            toolError(`No element on screen has the label or identifier ${JSON.stringify(element)}.`),
          )
        }
        if (element === undefined && x !== undefined && y !== undefined) return { x, y, what: `${x}, ${y}` }
        return yield* Effect.fail(toolError("Pass either element, or both x and y."))
      })

    return DeviceTools.of({
      device_screenshot: ({ device, save = false }) =>
        McpTool.CallingThread.use((threadId) => screen(threadId, device, "Screenshot of", save)),
      device_tap: ({ device, element, x, y, show = "screenshot" }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.gen(function* () {
            const target = yield* tapPoint(threadId, device, element, x, y)
            const { deviceId, ...point } = yield* at(threadId, device, target.x, target.y)
            return yield* actAndShow(
              threadId,
              deviceId,
              { kind: "tap", ...point },
              {
                steps: [
                  [
                    { kind: "touch", phase: "down", ...point },
                    { kind: "touch", phase: "up", ...point },
                  ],
                ],
              },
              show,
              `Tapped ${target.what}`,
            )
          }),
        ),
      device_swipe: ({ device, x, y, toX, toY, durationMs = 300, show = "screenshot" }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.gen(function* () {
            const { deviceId, ...from } = yield* at(threadId, device, x, y)
            const end = yield* at(threadId, deviceId, toX, toY)
            const to = { x: end.x, y: end.y }
            const along = (t: number) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
            const moves = Array.from({ length: SWIPE_STEPS }, (_, index): ReadonlyArray<DeviceCommand> => [
              { kind: "touch", phase: "move", ...along((index + 1) / SWIPE_STEPS) },
            ])
            return yield* actAndShow(
              threadId,
              deviceId,
              { kind: "swipe", ...from, toX: to.x, toY: to.y, durationMs },
              {
                steps: [[{ kind: "touch", phase: "down", ...from }], ...moves, [{ kind: "touch", phase: "up", ...to }]],
                gapMs: durationMs / (SWIPE_STEPS + 1),
                release: [{ kind: "touch", phase: "up", ...to }],
              },
              show,
              `Swiped from ${x}, ${y} to ${toX}, ${toY}`,
            )
          }),
        ),
      device_type: ({ device, text, show = "screenshot" }) =>
        McpTool.CallingThread.use((threadId) =>
          actAndShow(
            threadId,
            device,
            { kind: "type", characters: [...text].length },
            { steps: [[{ kind: "text", text }]] },
            show,
            `Typed ${[...text].length} characters`,
          ),
        ),
      device_button: ({ device, button, show = "screenshot" }) =>
        McpTool.CallingThread.use((threadId) =>
          actAndShow(
            threadId,
            device,
            { kind: "button", button },
            { steps: [[{ kind: "button", button }]] },
            show,
            `Pressed ${button}`,
          ),
        ),
      device_launch: ({ device, app, show = "screenshot" }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.gen(function* () {
            if ((yield* agentDevices.launch(threadId, device, app)) === "handedBack") {
              return yield* handedBack(threadId, device, show)
            }
            yield* Effect.sleep(SETTLE_MS * 2)
            return yield* shown(threadId, device, show, `Launched ${app}`)
          }),
        ),
      device_open_url: ({ device, url, show = "screenshot" }) =>
        McpTool.CallingThread.use((threadId) =>
          actAndShow(
            threadId,
            device,
            { kind: "openUrl", url },
            { steps: [[{ kind: "openUrl", url }]] },
            show,
            `Opened ${url}`,
          ),
        ),
      device_describe_ui: ({ device }) =>
        McpTool.CallingThread.use((threadId) => Effect.map(agentDevices.describe(threadId, device), describeLines)),
      device_install: ({ device, path }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.map(agentDevices.install(threadId, device, path), (installed) =>
            installed.app === null
              ? `Installed it on ${installed.device}.`
              : `Installed ${installed.app} on ${installed.device}. Launch it with device_launch.`,
          ),
        ),
      device_logs: ({ device, app, sinceSeconds = 60 }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.map(agentDevices.logs(threadId, device, app, sinceSeconds), (logs) =>
            logs.text.trim() === ""
              ? `No log lines on ${logs.device} in the last ${sinceSeconds} s.`
              : `Last ${sinceSeconds} s of logs on ${logs.device}, at most 200 lines:\n${logs.text}`,
          ),
        ),
    })
  }),
)
