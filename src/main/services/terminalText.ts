import { stripVTControlCharacters } from "node:util"

const ERASE_TO_END = "\uE000"
const ERASE_ROW = "\uE001"

// oxlint-disable-next-line no-control-regex -- removes the C0 controls stripVTControlCharacters leaves, such as BEL
const CONTROL = /[\u0000-\u0007\u000B\u000C\u000E-\u001F\u007F]/g

const printable = (raw: string) =>
  stripVTControlCharacters(
    raw
      .replaceAll(/[\uE000\uE001]/g, "")
      .replaceAll("\u001B[2K", ERASE_ROW)
      .replaceAll("\u001B[0K", ERASE_TO_END)
      .replaceAll("\u001B[K", ERASE_TO_END),
  ).replaceAll(CONTROL, "")

function screenLines(text: string, cols: number): Array<string> {
  const lines: Array<string> = []
  let line: Array<string> = []
  let cursor = 0
  let pendingWrap = false
  const rowStart = () => (pendingWrap ? cursor - cols : cursor - (cursor % cols))
  for (const char of text) {
    if (char === "\n") {
      lines.push(Array.from(line, (cell) => cell ?? " ").join(""))
      line = []
      cursor = 0
    } else if (char === "\r") cursor = rowStart()
    else if (char === "\b") cursor = Math.max(rowStart(), cursor - 1)
    else if (char === ERASE_TO_END) line.length = Math.min(line.length, cursor)
    else if (char === ERASE_ROW) line = [...line.slice(0, rowStart()), ...Array<string>(cursor - rowStart()).fill(" ")]
    else {
      line[cursor] = char
      cursor++
      pendingWrap = cursor % cols === 0
      continue
    }
    pendingWrap = false
  }
  lines.push(Array.from(line, (cell) => cell ?? " ").join(""))
  return lines.map((shown) => shown.trimEnd())
}

export function terminalText(raw: string, lines: number, cols: number): string {
  const all = screenLines(printable(raw), cols)
  while (all.at(-1) === "") all.pop()
  const shown = all.slice(-lines)
  while (shown[0] === "") shown.shift()
  return shown.join("\n")
}
