import { Effect, Schema } from "effect"
import { type McpSchema, Toolkit } from "effect/ai"
import { DeviceButton, type DeviceCommand, type DeviceElement, DeviceUrl } from "../../../shared/device.ts"
import { Attachments } from "../../services/Attachments.ts"
import { Devices } from "../../services/devices/Devices.ts"
import * as McpTool from "./tool.ts"

const Point = (what: string) =>
  Schema.Number.annotate({ description: `${what}, in screen points, the unit device_describe_ui reports frames in.` })

const STARTS =
  "Acts on one of the thread's devices; pass `device` when it has more than one. With none attached, creates a slim iOS simulator for the thread."
const WAITS = "While the user has control it waits for them to hand it back and then returns the screen without acting."
const SHOWS = "Returns a screenshot taken just after acting."
const HANDED_BACK =
  "The user had control and has handed it back. The screen may have changed, so this action was not performed. Look at the screenshot before you continue."
const Target = Schema.optionalKey(
  Schema.String.check(Schema.isMaxLength(200)).annotate({
    description:
      "The device's name or id, as an earlier device tool result shows it. Leave it out while the thread has at most one device.",
  }),
)
const SWIPE_STEPS = 12
const SETTLE_MS = 1000

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
    description: `Tap the device screen at a point. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({ device: Target, x: Point("Horizontal position"), y: Point("Vertical position") }),
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
    }),
  }),
  McpTool.make("device_type", {
    description: `Type text into the focused field. Tap the field first. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({
      device: Target,
      text: Schema.String.check(Schema.isMaxLength(10_000)).annotate({ description: "At most 10,000 characters." }),
    }),
  }),
  McpTool.make("device_button", {
    description: `Press a hardware button. back and recents exist on Android only. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({ device: Target, button: DeviceButton }),
  }),
  McpTool.make("device_launch", {
    description: `Launch an installed app by its iOS bundle id or Android package name. ${STARTS} ${SHOWS}`,
    parameters: Schema.Struct({ device: Target, app: Schema.String.check(Schema.isMaxLength(300)) }),
  }),
  McpTool.make("device_open_url", {
    description: `Open a URL on the device, such as a deep link like myapp://settings or an Expo dev server URL. ${STARTS} ${SHOWS}`,
    parameters: Schema.Struct({
      device: Target,
      url: DeviceUrl.annotate({ description: "A URL with a scheme, such as myapp://settings or https://example.com." }),
    }),
  }),
  McpTool.make("device_describe_ui", {
    description: `List the accessibility elements on screen, one per line with role, label, identifier, value and frame in points. Cheaper than a screenshot for finding what to tap. ${STARTS}`,
    parameters: Schema.Struct({ device: Target }),
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

export const deviceToolsLayer = DeviceTools.toLayer(
  Effect.gen(function* () {
    const devices = yield* Devices
    const attachments = yield* Attachments

    const screen = (threadId: string, device: string | undefined, caption: string, save = false) =>
      Effect.gen(function* () {
        const { frame, state } = yield* devices.screenshot(threadId, device)
        const data = Buffer.from(frame.data, "base64")
        const size = `${Math.round(state.screen.width)}×${Math.round(state.screen.height)} points`
        const about = `${caption} ${state.device.name} (${state.device.id}), ${state.device.osVersion}, screen ${size}${frame.orientation === "landscape" ? " (landscape)" : ""}.`
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

    const at = (threadId: string, device: string | undefined, x: number, y: number) =>
      Effect.map(devices.screenshot(threadId, device), ({ state }) => ({
        x: Math.min(1, Math.max(0, x / state.screen.width)),
        y: Math.min(1, Math.max(0, y / state.screen.height)),
        deviceId: state.device.id,
      }))

    const actAndLook = (
      threadId: string,
      device: string | undefined,
      steps: ReadonlyArray<ReadonlyArray<DeviceCommand>>,
      done: string,
      gapMs = 0,
      release: ReadonlyArray<DeviceCommand> = [],
    ) =>
      Effect.gen(function* () {
        for (const [index, commands] of steps.entries()) {
          if (index > 0 && gapMs > 0) yield* Effect.sleep(gapMs)
          const outcome = yield* devices.act(threadId, device, commands)
          if (outcome === "handedBack") {
            if (index > 0 && release.length > 0) yield* devices.act(threadId, device, release)
            return yield* screen(threadId, device, HANDED_BACK)
          }
        }
        yield* Effect.sleep(SETTLE_MS)
        return yield* screen(threadId, device, done)
      })

    return DeviceTools.of({
      device_screenshot: ({ device, save = false }) =>
        McpTool.CallingThread.use((threadId) => screen(threadId, device, "Screenshot of", save)),
      device_tap: ({ device, x, y }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.gen(function* () {
            const { deviceId, ...point } = yield* at(threadId, device, x, y)
            return yield* actAndLook(
              threadId,
              deviceId,
              [
                [
                  { kind: "touch", phase: "down", ...point },
                  { kind: "touch", phase: "up", ...point },
                ],
              ],
              `Tapped ${x}, ${y} on`,
            )
          }),
        ),
      device_swipe: ({ device, x, y, toX, toY, durationMs = 300 }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.gen(function* () {
            const { deviceId, ...from } = yield* at(threadId, device, x, y)
            const end = yield* at(threadId, deviceId, toX, toY)
            const to = { x: end.x, y: end.y }
            const along = (t: number) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
            const moves = Array.from({ length: SWIPE_STEPS }, (_, index): ReadonlyArray<DeviceCommand> => [
              { kind: "touch", phase: "move", ...along((index + 1) / SWIPE_STEPS) },
            ])
            return yield* actAndLook(
              threadId,
              deviceId,
              [[{ kind: "touch", phase: "down", ...from }], ...moves, [{ kind: "touch", phase: "up", ...to }]],
              `Swiped from ${x}, ${y} to ${toX}, ${toY} on`,
              durationMs / (SWIPE_STEPS + 1),
              [{ kind: "touch", phase: "up", ...to }],
            )
          }),
        ),
      device_type: ({ device, text }) =>
        McpTool.CallingThread.use((threadId) =>
          actAndLook(threadId, device, [[{ kind: "text", text }]], `Typed ${[...text].length} characters on`),
        ),
      device_button: ({ device, button }) =>
        McpTool.CallingThread.use((threadId) =>
          actAndLook(threadId, device, [[{ kind: "button", button }]], `Pressed ${button} on`),
        ),
      device_launch: ({ device, app }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.gen(function* () {
            yield* devices.launch(threadId, device, app)
            yield* Effect.sleep(SETTLE_MS * 2)
            return yield* screen(threadId, device, `Launched ${app} on`)
          }),
        ),
      device_open_url: ({ device, url }) =>
        McpTool.CallingThread.use((threadId) =>
          actAndLook(threadId, device, [[{ kind: "openUrl", url }]], `Opened ${url} on`),
        ),
      device_describe_ui: ({ device }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.map(devices.describe(threadId, device), (elements) =>
            elements.length === 0 ? "No accessibility elements on screen." : elements.map(describeLine).join("\n"),
          ),
        ),
    })
  }),
)
