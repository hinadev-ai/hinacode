import type { WTerm } from "@wterm/dom"
import wasmUrl from "@wterm/ghostty/ghostty-vt.wasm?url"
import { m } from "../paraglide/messages.js"
import { callPromise } from "./rpc.ts"
import { TerminalBacklog } from "./terminalBacklog.ts"
import { TerminalStream } from "./terminalStream.ts"

interface Screen {
  readonly element: HTMLDivElement
  term: WTerm | null
  readonly backlog: TerminalBacklog
  readonly stream: TerminalStream
  wantsFocus: boolean
  paused: boolean
}

const SCROLLBACK_BYTES = 4 * 1024 * 1024

const SCREEN_CLASS = "terminal-screen"

const screens = new Map<string, Screen>()
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
        // FIXME: libghostty clears its scrollback only on RIS
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

const ignore = () => {}

const start = async (id: string, screen: Screen) => {
  const [{ WTerm }, { GhosttyCore }] = await Promise.all([import("@wterm/dom"), import("@wterm/ghostty")])
  const core = await GhosttyCore.load({ wasmPath: wasmUrl, scrollbackLimit: SCROLLBACK_BYTES })
  const { element } = screen
  // FIXME: wterm checks whether the view sits at the bottom only after the element shrinks
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
  // FIXME: wterm init() does not report its first size through onResize
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

export function writeTerminal(id: string, data: string, offset?: number) {
  if (!disposed.has(id)) screenFor(id).stream.data(data, offset)
}

export function terminalExited(id: string, exitCode: number | null) {
  screens.get(id)?.stream.exited(exitCode)
}

export function attachTerminalOutput(id: string) {
  return disposed.has(id) ? Promise.resolve(null) : screenFor(id).stream.attach()
}

export function disposeTerminal(id: string) {
  screens.get(id)?.stream.dispose()
  screens.get(id)?.term?.destroy()
  screens.get(id)?.element.remove()
  screens.delete(id)
  disposed.add(id)
}
