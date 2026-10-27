import { Effect, Schema } from "effect"
import { type McpSchema, Toolkit } from "effect/ai"
import { DeviceButton, type DeviceCommand, type DeviceElement } from "../../../shared/device.ts"
import { Attachments } from "../../services/Attachments.ts"
import { Devices, DevicesError } from "../../services/devices/Devices.ts"
import { SETTLE_MS } from "./tinyVm.ts"
import * as McpTool from "./tool.ts"

const Point = (what: string) =>
  Schema.Number.annotate({ description: `${what}, in screen points, the unit device_describe_ui reports frames in.` })

const STARTS = "Uses the device attached to this thread, and creates a slim iOS simulator for it when there is none."
const WAITS = "While the user has control it waits for them to hand it back and then returns the screen without acting."
const SHOWS = "Returns a screenshot taken just after acting."
const HANDED_BACK =
  "The user had control and has handed it back. The screen may have changed, so this action was not performed. Look at the screenshot before you continue."
const SWIPE_STEPS = 12

export const DeviceTools = Toolkit.make(
  McpTool.make("device_screenshot", {
    description: `Take a screenshot of the thread's iOS simulator or Android emulator. ${STARTS}`,
    parameters: Schema.Struct({
      save: Schema.optionalKey(
        Schema.Boolean.annotate({
          description: "Also save the image on this machine and return Markdown that embeds it, to show the user.",
        }),
      ),
    }),
  }),
  McpTool.make("device_tap", {
    description: `Tap the device screen at a point. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({ x: Point("Horizontal position"), y: Point("Vertical position") }),
  }),
  McpTool.make("device_swipe", {
    description: `Swipe with one finger from one point to another, for example to scroll or go back from the left edge. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({
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
      text: Schema.String.check(Schema.isMaxLength(10_000)).annotate({ description: "At most 10,000 characters." }),
    }),
  }),
  McpTool.make("device_button", {
    description: `Press a hardware button. back and recents exist on Android only. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({ button: DeviceButton }),
  }),
  McpTool.make("device_launch", {
    description: `Launch an installed app by its iOS bundle id or Android package name. ${STARTS} ${SHOWS}`,
    parameters: Schema.Struct({ app: Schema.String.check(Schema.isMaxLength(300)) }),
  }),
  McpTool.make("device_open_url", {
    description: `Open a URL on the device, such as a deep link like myapp://settings or an Expo dev server URL. ${STARTS} ${SHOWS}`,
    parameters: Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(2048)) }),
  }),
  McpTool.make("device_describe_ui", {
    description: `List the accessibility elements on screen, one per line with role, label, identifier, value and frame in points. Cheaper than a screenshot for finding what to tap. ${STARTS}`,
    parameters: Schema.Struct({}),
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

    /** The thread's device, ready. A screenshot first, because that creates and boots one when the thread has none. */
    const screenOf = (threadId: string) =>
      devices.screenshot(threadId).pipe(
        Effect.andThen(devices.get(threadId)),
        Effect.flatMap((state) =>
          state.phase === "ready"
            ? Effect.succeed(state)
            : Effect.fail(
                new DevicesError({
                  message: state.phase === "failed" ? state.message : "The device is not ready yet.",
                }),
              ),
        ),
      )

    const screen = (threadId: string, caption: string, save = false) =>
      Effect.gen(function* () {
        const frame = yield* devices.screenshot(threadId)
        const state = yield* screenOf(threadId)
        const data = Buffer.from(frame.data, "base64")
        const size = `${Math.round(state.screen.width)}×${Math.round(state.screen.height)} points`
        const about = `${caption} ${state.device.name}, ${state.device.osVersion}, screen ${size}${frame.orientation === "landscape" ? " (landscape)" : ""}.`
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

    /** Points to fractions of the screen, which is what device input takes. */
    const at = (threadId: string, x: number, y: number) =>
      Effect.map(screenOf(threadId), ({ screen }) => ({
        x: Math.min(1, Math.max(0, x / screen.width)),
        y: Math.min(1, Math.max(0, y / screen.height)),
      }))

    const actAndLook = (
      threadId: string,
      steps: ReadonlyArray<ReadonlyArray<DeviceCommand>>,
      done: string,
      gapMs = 0,
    ) =>
      Effect.gen(function* () {
        for (const [index, commands] of steps.entries()) {
          if (index > 0 && gapMs > 0) yield* Effect.sleep(gapMs)
          const outcome = yield* devices.act(threadId, commands)
          if (outcome === "handedBack") return yield* screen(threadId, HANDED_BACK)
        }
        yield* Effect.sleep(SETTLE_MS)
        return yield* screen(threadId, done)
      })

    return DeviceTools.of({
      device_screenshot: ({ save = false }) =>
        McpTool.CallingThread.use((threadId) => screen(threadId, "Screenshot of", save)),
      device_tap: ({ x, y }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.gen(function* () {
            const point = yield* at(threadId, x, y)
            return yield* actAndLook(
              threadId,
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
      device_swipe: ({ x, y, toX, toY, durationMs = 300 }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.gen(function* () {
            const from = yield* at(threadId, x, y)
            const to = yield* at(threadId, toX, toY)
            const along = (t: number) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
            const moves = Array.from({ length: SWIPE_STEPS }, (_, index): ReadonlyArray<DeviceCommand> => [
              { kind: "touch", phase: "move", ...along((index + 1) / SWIPE_STEPS) },
            ])
            return yield* actAndLook(
              threadId,
              [[{ kind: "touch", phase: "down", ...from }], ...moves, [{ kind: "touch", phase: "up", ...to }]],
              `Swiped from ${x}, ${y} to ${toX}, ${toY} on`,
              durationMs / (SWIPE_STEPS + 1),
            )
          }),
        ),
      device_type: ({ text }) =>
        McpTool.CallingThread.use((threadId) =>
          actAndLook(threadId, [[{ kind: "text", text }]], `Typed ${[...text].length} characters on`),
        ),
      device_button: ({ button }) =>
        McpTool.CallingThread.use((threadId) =>
          actAndLook(threadId, [[{ kind: "button", button }]], `Pressed ${button} on`),
        ),
      device_launch: ({ app }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.gen(function* () {
            yield* devices.launch(threadId, app)
            yield* Effect.sleep(SETTLE_MS * 2)
            return yield* screen(threadId, `Launched ${app} on`)
          }),
        ),
      device_open_url: ({ url }) =>
        McpTool.CallingThread.use((threadId) => actAndLook(threadId, [[{ kind: "openUrl", url }]], `Opened ${url} on`)),
      device_describe_ui: () =>
        McpTool.CallingThread.use((threadId) =>
          Effect.map(devices.describe(threadId), (elements) =>
            elements.length === 0 ? "No accessibility elements on screen." : elements.map(describeLine).join("\n"),
          ),
        ),
    })
  }),
)
