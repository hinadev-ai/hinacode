import { WTerm } from "@wterm/dom"
import { GhosttyCore } from "@wterm/ghostty"
import wasmUrl from "@wterm/ghostty/ghostty-vt.wasm?url"
import { m } from "../paraglide/messages.js"
import { callPromise } from "./rpc.ts"
import { TerminalBacklog } from "./terminalBacklog.ts"
import { TerminalStream } from "./terminalStream.ts"

/**
 * One libghostty screen per terminal session, kept outside React so a session keeps its screen and
 * scrollback while its drawer is hidden or another thread is open. Output goes straight from the push
 * listener to the screen and never re-renders a component.
 */
interface Screen {
  readonly element: HTMLDivElement
  term: WTerm | null
  /** Output that arrived before the screen was first shown and measured. */
  readonly backlog: TerminalBacklog
  readonly stream: TerminalStream
  /** Focus asked for before the screen was ready. */
  wantsFocus: boolean
  /** Hidden tabs and drawers keep parsing output but skip painting. */
  paused: boolean
}

/** Ghostty takes a byte budget, with retained rows depending on terminal width. */
const SCROLLBACK_BYTES = 4 * 1024 * 1024

const SCREEN_CLASS = "terminal-screen"

const screens = new Map<string, Screen>()
/** Closed sessions, so output still in flight when a tab closes does not create a new screen. */
const disposed = new Set<string>()

const write = (screen: Screen, data: string) => {
  if (screen.term) screen.term.write(data)
  else screen.backlog.append(data)
}

const screenFor = (id: string) => {
  const existing = screens.get(id)
  if (existing) return existing
  const element = document.createElement("div")
  element.className = SCREEN_CLASS
  const screen: Screen = {
    element,
    term: null,
    backlog: new TerminalBacklog(),
    stream: new TerminalStream(
      {
        write: (data) => write(screen, data),
        // RIS also clears libghostty's scrollback.
        reset: () => (screen.term ? screen.term.write("\x1bc") : void screen.backlog.drain()),
        exited: (exitCode) => {
          const message = exitCode === null ? m.terminal_ended() : m.terminal_exited({ code: exitCode })
          write(screen, `\r\n\x1b[2m${message}\x1b[22m\r\n`)
        },
      },
      (since) => callPromise("terminal.attach", { id, since }),
    ),
    wantsFocus: false,
    paused: false,
  }
  screens.set(id, screen)
  return screen
}

// Input racing a close has nowhere to go, and main already ignores input to an exited shell.
const ignore = () => {}

const start = async (id: string, screen: Screen) => {
  const core = await GhosttyCore.load({ wasmPath: wasmUrl, scrollbackLimit: SCROLLBACK_BYTES })
  const { element } = screen
  // wterm checks whether the view sits at the bottom only after the element has already shrunk, so a
  // smaller drawer would leave the prompt below the fold. Track it from the user's scrolling, ignore the
  // scrolls a resize causes, and pin the view again once wterm has repainted.
  let atBottom = true
  let resizing = false
  element.addEventListener("scroll", () => {
    if (!resizing) atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1
  })
  const resize = (cols: number, rows: number) => {
    void callPromise("terminal.resize", { id, cols, rows }).catch(ignore)
    if (!atBottom || resizing) return
    resizing = true
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        element.scrollTo({ top: element.scrollHeight })
        resizing = false
      }),
    )
  }
  const term = new WTerm(element, {
    core,
    renderingPaused: screen.paused,
    onData: (data) => void callPromise("terminal.write", { id, data }).catch(ignore),
    onResize: resize,
  })
  await term.init()
  // init() measures the element for its first size without reporting it through onResize.
  void callPromise("terminal.resize", { id, cols: term.cols, rows: term.rows }).catch(ignore)
  if (!screens.has(id)) return term.destroy()
  screen.term = term
  const replay = screen.backlog.drain()
  for (const data of replay.chunks) term.write(data)
  if (replay.truncated) term.write(`\r\n\x1b[0m\x1b[2m${m.terminal_output_truncated()}\x1b[22m\r\n`)
  if (screen.wantsFocus) term.focus()
}

export const isInTerminal = (target: EventTarget | null) =>
  target instanceof Element && target.closest(`.${SCREEN_CLASS}`) !== null

/** Moves the session's screen into `container`, creating it on first use. Returns a function that detaches it. */
export function attachTerminal(id: string, container: HTMLElement): () => void {
  const screen = screenFor(id)
  container.append(screen.element)
  if (!screen.term && screen.element.dataset["starting"] === undefined) {
    screen.element.dataset["starting"] = ""
    void start(id, screen)
  }
  return () => {
    showTerminal(id, false)
    screen.element.remove()
  }
}

export function showTerminal(id: string, visible: boolean) {
  const screen = screens.get(id)
  if (!screen) return
  screen.paused = !visible
  screen.term?.setRenderingPaused(!visible)
}

export function focusTerminal(id: string) {
  const screen = screens.get(id)
  if (screen?.term) screen.term.focus()
  else if (screen) screen.wantsFocus = true
}

/** A `terminal.data` push. */
export function writeTerminal(id: string, data: string, offset?: number) {
  if (!disposed.has(id)) screenFor(id).stream.data(data, offset)
}

export function terminalExited(id: string, exitCode: number | null) {
  screens.get(id)?.stream.exited(exitCode)
}

/**
 * Catches the session's screen up with the output main keeps, after a reload or a cloud reconnect. Resolves with the
 * session, or null when it is gone or the cloud predates `terminal.attach`.
 */
export function attachTerminalOutput(id: string) {
  return disposed.has(id) ? Promise.resolve(null) : screenFor(id).stream.attach()
}

export function disposeTerminal(id: string) {
  screens.get(id)?.term?.destroy()
  screens.get(id)?.element.remove()
  screens.delete(id)
  disposed.add(id)
}
