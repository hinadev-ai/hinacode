export interface ShellState {
  readonly cwd: string
  readonly command: string | null
  readonly lastExitCode: number | null
}

const MAX_PENDING = 8192

// oxlint-disable-next-line no-control-regex -- matches OSC sequences, which start with ESC ] and end with BEL or ESC \
const OSC = /\u001B\](133|633|7);([^\u0007\u001B]*)(?:\u0007|\u001B\\)/g

// oxlint-disable-next-line no-control-regex -- BEL or ESC \ ends an OSC sequence
const OSC_END = /\u0007|\u001B\\/

const unfinishedTail = (text: string, from: number) => {
  const osc = text.lastIndexOf("\u001B]")
  let start = -1
  if (osc >= from && !OSC_END.test(text.slice(osc))) start = osc
  else if (text.endsWith("\u001B")) start = text.length - 1
  return start >= from && text.length - start <= MAX_PENDING ? text.slice(start) : ""
}

const cwdFromUrl = (url: string) => {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(url)
  return match?.[1] ?? null
}

// oxlint-disable-next-line no-control-regex -- a command line spanning lines reads as one
const CONTROL = /[\u0000-\u001F\u007F]+/g

const urlCommandLine = (params: ReadonlyArray<string>) => {
  const url = params.find((param) => param.startsWith("cmdline_url="))
  if (url === undefined) return null
  try {
    return decodeURIComponent(url.slice("cmdline_url=".length)).replaceAll(CONTROL, " ").trim()
  } catch {
    return null
  }
}

const apply = (state: ShellState, code: string, params: string, typed: { line: string | null }): ShellState => {
  if (code === "7") {
    const cwd = cwdFromUrl(params)
    return cwd === null ? state : { ...state, cwd }
  }
  const [kind = "", ...rest] = params.split(";")
  if (code === "633") {
    if (kind === "E") typed.line = rest.join(";").trim()
    return state
  }
  if (kind === "C") {
    const line = typed.line ?? urlCommandLine(rest)
    typed.line = null
    if (line === null && state.command !== null) return state
    return { ...state, command: line ?? "" }
  }
  if (kind === "D" && state.command !== null) {
    const exitCode = Number.parseInt(rest[0] ?? "", 10)
    return { ...state, command: null, lastExitCode: Number.isNaN(exitCode) ? null : exitCode }
  }
  return state
}

export class ShellMarks {
  #pending = ""
  readonly #typed: { line: string | null } = { line: null }
  state: ShellState

  constructor(cwd: string) {
    this.state = { cwd, command: null, lastExitCode: null }
  }

  read(data: string): boolean {
    const text = this.#pending + data
    const before = this.state
    let consumed = 0
    for (const match of text.matchAll(OSC)) {
      this.state = apply(this.state, match[1] ?? "", match[2] ?? "", this.#typed)
      consumed = match.index + match[0].length
    }
    this.#pending = unfinishedTail(text, consumed)
    return (
      this.state.cwd !== before.cwd ||
      this.state.command !== before.command ||
      this.state.lastExitCode !== before.lastExitCode
    )
  }
}
