import { Effect, Schema } from "effect"
import { type McpSchema, Toolkit } from "effect/ai"
import { Attachments } from "../../services/Attachments.ts"
import type { VmAction } from "../../services/tinyVm/rfb.ts"
import type { ExecResult } from "../../services/tinyVm/sbx.ts"
import type { WrittenTree } from "../../services/tinyVm/tar.ts"
import { MAX_TRANSFER_BYTES, TinyVm } from "../../services/tinyVm/TinyVm.ts"
import * as McpTool from "./tool.ts"

export const SETTLE_MS = 500
const MAX_OUTPUT_CHARS = 20_000

const tail = (label: string, bytes: Uint8Array) => {
  const output = Buffer.from(bytes).toString()
  if (output === "") return `${label}: (empty)`
  if (output.length <= MAX_OUTPUT_CHARS) return `${label}:\n${output}`
  return `${label} (last ${MAX_OUTPUT_CHARS} of ${output.length} characters):\n${output.slice(-MAX_OUTPUT_CHARS)}`
}

const execReport = (result: ExecResult, timeoutSeconds: number, background: boolean) => {
  if (background) {
    return result.exitCode === 0 && result.pid !== undefined
      ? `Started in the background as pid ${result.pid}. Output goes to ${result.log ?? "the sbx log"}.`
      : `Could not start it in the background (exit code ${result.exitCode}). ${result.error ?? ""}`.trim()
  }
  const status =
    result.exitCode === 124 ? `Timed out after ${timeoutSeconds} s (exit code 124).` : `Exit code ${result.exitCode}.`
  return [
    status,
    ...(result.error ? [result.error] : []),
    tail("stdout", result.stdout),
    tail("stderr", result.stderr),
  ].join("\n\n")
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const pullReport = (guestPath: string, pulled: WrittenTree) =>
  [
    `Copied ${guestPath} from the VM to ${pulled.path} (${pulled.files} ${pulled.files === 1 ? "file" : "files"}, ${megabytes(pulled.bytes)}).`,
    ...(pulled.skippedLinks.length === 0 ? [] : [`Skipped symlinks: ${pulled.skippedLinks.join(", ")}`]),
  ].join("\n")

const Coordinate = (axis: "x" | "y", what: string) =>
  Schema.Int.annotate({
    description: `${what}, in pixels of the latest screenshot from the ${axis === "x" ? "left" : "top"} edge.`,
  })

const STARTS = "Starts the thread's tiny VM on first use."
const WAITS = "While the user has control it waits for them to hand it back and then returns the screen without acting."
const SHOWS = "Returns a screenshot taken just after acting."
const HANDED_BACK =
  "The user had control and has handed it back. The screen may have changed, so this action was not performed. Look at the screenshot before you continue."

export const VmTools = Toolkit.make(
  McpTool.make("vm_screenshot", {
    description: `Take a screenshot of the tiny VM's 1280×800 desktop. ${STARTS}`,
    parameters: Schema.Struct({
      save: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "Also save the PNG on this machine and return Markdown that embeds it, so you can show the screen to the user in your reply.",
        }),
      ),
    }),
  }),
  McpTool.make("vm_click", {
    description: `Click in the tiny VM at a point of the latest screenshot. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({
      x: Coordinate("x", "Horizontal position"),
      y: Coordinate("y", "Vertical position"),
      button: Schema.optionalKey(
        Schema.Literals(["left", "right", "middle"]).annotate({ description: "Defaults to left." }),
      ),
      clicks: Schema.optionalKey(
        Schema.Literals([1, 2, 3]).annotate({ description: "1, 2 for a double click or 3. Defaults to 1." }),
      ),
    }),
  }),
  McpTool.make("vm_move", {
    description: `Move the tiny VM's pointer to a point of the latest screenshot, for example to hover. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({
      x: Coordinate("x", "Horizontal position"),
      y: Coordinate("y", "Vertical position"),
    }),
  }),
  McpTool.make("vm_drag", {
    description: `Drag with the left button held from one point of the latest screenshot to another. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({
      x: Coordinate("x", "Start position"),
      y: Coordinate("y", "Start position"),
      toX: Coordinate("x", "End position"),
      toY: Coordinate("y", "End position"),
    }),
  }),
  McpTool.make("vm_scroll", {
    description: `Scroll the mouse wheel in the tiny VM with the pointer at a point of the latest screenshot. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({
      x: Coordinate("x", "Pointer position"),
      y: Coordinate("y", "Pointer position"),
      direction: Schema.Literals(["up", "down", "left", "right"]),
      amount: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
          description: "Wheel notches, 1-20. Defaults to 3.",
        }),
      ),
    }),
  }),
  McpTool.make("vm_type", {
    description: `Type text into the tiny VM's focused window, as key presses. Any Unicode text works; "\\n" presses Return and "\\t" Tab. Click the field first. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({
      text: Schema.String.check(Schema.isMaxLength(10_000)).annotate({ description: "At most 10,000 characters." }),
    }),
  }),
  McpTool.make("vm_key", {
    description: `Press keys or shortcuts in the tiny VM, xdotool style: Return, Escape, BackSpace, Tab, Page_Down, F5, ctrl+l, ctrl+shift+t, alt+F4. Separate several with spaces to press them in order. ${STARTS} ${WAITS} ${SHOWS}`,
    parameters: Schema.Struct({
      keys: Schema.String.annotate({ description: "For example `ctrl+a BackSpace` or `Return`." }),
    }),
  }),
  McpTool.make("vm_exec", {
    description: `Run a bash script in the tiny VM as \`user\` (passwordless sudo, DISPLAY=:0) and return its exit code, stdout and stderr. Start GUI programs and servers with \`background: true\`. ${STARTS}`,
    parameters: Schema.Struct({
      command: Schema.String.annotate({ description: "Run with bash -lc." }),
      timeoutSeconds: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })).annotate({
          description: "1-600. Defaults to 120.",
        }),
      ),
      background: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Return at once with the pid and log path instead of waiting." }),
      ),
    }),
  }),
  McpTool.make("vm_pull_file", {
    description: `Copy a file or folder from the tiny VM to this machine, to hand back something made or downloaded there. It lands in a new folder HinaCode picks, and the result names the path; copy or move it from there yourself. At most ${MAX_TRANSFER_BYTES / 1024 / 1024} MB, so compress or split anything bigger first. Symlinks are skipped and files lose their execute bit. ${STARTS}`,
    parameters: Schema.Struct({
      path: Schema.String.annotate({
        description:
          "The file or folder in the VM, absolute or relative to the home folder, like `~/Downloads/report.pdf`.",
      }),
    }),
  }),
)

const shown = (data: Uint8Array, caption: string): ReadonlyArray<McpSchema.ContentBlock> => [
  { type: "text", text: caption },
  { type: "image", data, mimeType: "image/png" },
]

export const vmToolsLayer = VmTools.toLayer(
  Effect.gen(function* () {
    const tinyVm = yield* TinyVm
    const attachments = yield* Attachments

    const droppedNotice = (threadId: string) =>
      Effect.map(tinyVm.takeDropped(threadId), (paths) =>
        paths.length === 0 ? undefined : `The user dropped files into the VM: ${paths.join(", ")}`,
      )

    const screen = (threadId: string, caption: string) =>
      Effect.gen(function* () {
        const data = yield* tinyVm.screenshot(threadId)
        const notice = yield* droppedNotice(threadId)
        return [...shown(data, caption), ...(notice === undefined ? [] : [{ type: "text", text: notice } as const])]
      })

    // FIXME: Markdown needs angle brackets to keep a link path with spaces whole
    const saveScreen = (threadId: string) =>
      Effect.gen(function* () {
        const data = yield* tinyVm.screenshot(threadId)
        const { path } = yield* attachments.stage(threadId, {
          dataUrl: `data:image/png;base64,${Buffer.from(data).toString("base64")}`,
          name: "vm-screenshot.png",
        })
        return shown(data, `Screen 1280×800, saved to ${path}. Embed it with: ![VM screenshot](<${path}>)`)
      })

    const actAndLook = (action: VmAction, done: string) =>
      Effect.gen(function* () {
        const threadId = yield* McpTool.CallingThread
        const outcome = yield* tinyVm.act(threadId, [action])
        if (outcome === "done") yield* Effect.sleep(SETTLE_MS)
        return yield* screen(threadId, outcome === "done" ? done : HANDED_BACK)
      })

    return VmTools.of({
      vm_screenshot: ({ save = false }) =>
        McpTool.CallingThread.use((threadId) => (save ? saveScreen(threadId) : screen(threadId, "Screen 1280×800."))),
      vm_click: ({ x, y, button = "left", clicks = 1 }) =>
        actAndLook(
          { type: "click", x, y, button, clicks },
          `${clicks === 1 ? "Clicked" : `Clicked ${clicks} times`} ${button} at ${x}, ${y}.`,
        ),
      vm_move: ({ x, y }) => actAndLook({ type: "move", x, y }, `Moved the pointer to ${x}, ${y}.`),
      vm_drag: ({ x, y, toX, toY }) =>
        actAndLook({ type: "drag", x, y, toX, toY }, `Dragged from ${x}, ${y} to ${toX}, ${toY}.`),
      vm_scroll: ({ x, y, direction, amount = 3 }) =>
        actAndLook(
          { type: "scroll", x, y, direction, amount },
          `Scrolled ${direction} ${amount} ${amount === 1 ? "notch" : "notches"} at ${x}, ${y}.`,
        ),
      vm_type: ({ text }) => actAndLook({ type: "type", text }, `Typed ${[...text].length} characters.`),
      vm_key: ({ keys }) => actAndLook({ type: "key", keys }, `Pressed ${keys}.`),
      vm_exec: ({ command, timeoutSeconds = 120, background = false }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.gen(function* () {
            const output = yield* tinyVm.exec(threadId, { command, timeoutSeconds, background })
            const notice = yield* droppedNotice(threadId)
            const report = execReport(output, timeoutSeconds, background)
            return notice === undefined ? report : `${report}\n\n${notice}`
          }),
        ),
      vm_pull_file: ({ path }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.map(tinyVm.pullFiles(threadId, path), (pulled) => pullReport(path, pulled)),
        ),
    })
  }),
)
