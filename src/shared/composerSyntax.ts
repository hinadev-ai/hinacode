import type { AgentCommand } from "./agent.ts"
import type { PullRequestMatch, TerminalSession, Thread } from "./domain.ts"
import { type MentionableThreads, parseMention, terminalMention, threadMention } from "./mentions.ts"

export type SyntaxKind = "text" | "bullet" | "code" | "strong" | "rule" | "command" | "mention"

export interface KnownTokens {
  readonly commands: ReadonlySet<string>
  readonly files: ReadonlySet<string>
  readonly threads: ReadonlySet<string>
  readonly terminals: ReadonlySet<string>
}

export interface Span {
  readonly kind: SyntaxKind
  readonly text: string
}

export interface Fence {
  readonly kind: "fence"
  readonly language: string
  readonly open: string
  readonly lines: ReadonlyArray<string>
  readonly close: string | null
}

export type Segment = Span | Fence

export const fenceCode = (fence: Fence) => fence.lines.join("\n")

export const segmentText = (segment: Segment) =>
  segment.kind === "fence"
    ? [segment.open, ...segment.lines, ...(segment.close === null ? [] : [segment.close])].join("\n")
    : segment.text

const FENCE = /^\s*```\s*([^\s`]*)/
const BULLET = /^(\s*)([-*+]|\d+[.)])(?=\s)/
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/
const NAME = String.raw`[\w:-]+(?:\.[\w:-]+)*`
const INLINE = new RegExp(
  String.raw`\`[^\`\n]+\`|\*\*[^\s*](?:[^*\n]*[^\s*])?\*\*|(?<=^|\s)(?:@[^\s]+|[/$]${NAME})`,
  "g",
)
const WHOLE_NAME = new RegExp(`^${NAME}$`)

export const isUnorderedBullet = (marker: string) => /^[-*+]$/.test(marker)

export const isCommandName = (name: string) => WHOLE_NAME.test(name)
const TRAILING_PUNCTUATION = /[,.;:!?)\]]+$/

const classify = (token: string, known: KnownTokens): { kind: SyntaxKind; text: string } | null => {
  if (token.startsWith("`")) return { kind: "code", text: token }
  if (token.startsWith("**")) return { kind: "strong", text: token }
  if (token.startsWith("@")) {
    const mention = token.replace(TRAILING_PUNCTUATION, "")
    const parsed = parseMention(mention)
    const isKnown =
      parsed === null
        ? known.files.has(mention.slice(1))
        : (parsed.kind === "thread" ? known.threads : known.terminals).has(parsed.id)
    return isKnown ? { kind: "mention", text: mention } : null
  }
  return known.commands.has(token) ? { kind: "command", text: token } : null
}

const inline = (line: string, known: KnownTokens): Array<Segment> => {
  const segments: Array<Segment> = []
  let last = 0
  for (const match of line.matchAll(INLINE)) {
    const token = classify(match[0], known)
    if (token === null) continue
    segments.push({ kind: "text", text: line.slice(last, match.index) }, token)
    last = match.index + token.text.length
  }
  segments.push({ kind: "text", text: line.slice(last) })
  return segments
}

const merge = (segments: ReadonlyArray<Segment>) =>
  segments.reduce<Array<Segment>>((merged, segment) => {
    if (segment.kind !== "fence" && segment.text === "") return merged
    const previous = merged.at(-1)
    if (segment.kind !== "fence" && previous?.kind === segment.kind)
      merged[merged.length - 1] = { ...segment, text: previous.text + segment.text }
    else merged.push(segment)
    return merged
  }, [])

export function endsWithClosedFence(text: string): boolean {
  let inFence = false
  let closedLast = false
  for (const line of text.split("\n")) {
    closedLast = inFence && FENCE.test(line)
    if (FENCE.test(line)) inFence = !inFence
  }
  return closedLast
}

const insideFence = (text: string, lineStart: number) => {
  const fences = text
    .slice(0, lineStart)
    .split("\n")
    .filter((line) => FENCE.test(line))
  return fences.length % 2 === 1
}

export interface TextEdit {
  readonly from: number
  readonly to: number
  readonly insert: string
  readonly anchor: number
}

interface ListItem {
  readonly prefix: string
  readonly indent: string
  readonly marker: string
  readonly ordered: boolean
  readonly kind: string
  readonly space: string
  readonly task: boolean
}

const listItem = (line: string): ListItem | null => {
  const match = LIST_ITEM.exec(line)
  if (match === null) return null
  const [prefix, indent = "", bullet, number, delimiter = "", space = "", task] = match
  return {
    prefix,
    indent,
    marker: bullet ?? `${number}${delimiter}`,
    ordered: bullet === undefined,
    kind: bullet ?? delimiter,
    space,
    task: task !== undefined,
  }
}

const withMarker = (line: string, item: ListItem, indent: string, marker: string) =>
  indent + marker + line.slice(item.indent.length + item.marker.length)

const contentColumn = (item: ListItem) => item.indent.length + item.marker.length + item.space.length

interface ListBlock {
  readonly from: number
  readonly to: number
  readonly lines: ReadonlyArray<string>
  readonly row: number
  readonly column: number
}

interface ListCaret {
  readonly lines: ReadonlyArray<string>
  readonly row: number
  readonly fromPrefixEnd: number
}

const listBlockAt = (text: string, caret: number): ListBlock | null => {
  const lines = text.split("\n")
  const before = text.slice(0, caret).split("\n")
  const row = before.length - 1
  const column = before[row]!.length
  const isItem = (index: number) => LIST_ITEM.test(lines[index] ?? "")
  if (!isItem(row) || insideFence(text, caret - column)) return null
  let first = row
  while (isItem(first - 1)) first--
  let last = row
  while (isItem(last + 1)) last++
  const from = lines.slice(0, first).join("\n").length + (first > 0 ? 1 : 0)
  const block = lines.slice(first, last + 1)
  return { from, to: from + block.join("\n").length, lines: block, row: row - first, column }
}

function renumber(lines: ReadonlyArray<string>): Array<string> {
  const levels: Array<{ indent: number; kind: string; next: number }> = []
  const shifts: Array<{ indent: number; by: number }> = []
  return lines.map((original) => {
    const originalItem = listItem(original)
    if (originalItem === null) {
      levels.length = 0
      shifts.length = 0
      return original
    }
    while ((shifts.at(-1)?.indent ?? -1) >= originalItem.indent.length) shifts.pop()
    const by = shifts.reduce((sum, shift) => sum + shift.by, 0)
    const line = by >= 0 ? " ".repeat(by) + original : original.slice(-by)
    const item = listItem(line)!
    const indent = item.indent.length
    while ((levels.at(-1)?.indent ?? -1) > indent) levels.pop()
    if (levels.at(-1)?.indent === indent && levels.at(-1)?.kind !== item.kind) levels.pop()
    let level = levels.at(-1)
    if (level?.indent !== indent) {
      level = { indent, kind: item.kind, next: levels.length === 0 ? Number.parseInt(item.marker) : 1 }
      levels.push(level)
    }
    if (!item.ordered) return line
    const marker = `${level.next++}${item.kind}`
    shifts.push({ indent: originalItem.indent.length, by: marker.length - item.marker.length })
    return withMarker(line, item, item.indent, marker)
  })
}

const subtreeEnd = (lines: ReadonlyArray<string>, row: number, depth: number) => {
  let end = row + 1
  while (end < lines.length && listItem(lines[end]!)!.indent.length > depth) end++
  return end
}

const parentRow = (lines: ReadonlyArray<string>, row: number, depth: number) => {
  for (let index = row - 1; index >= 0; index--) if (listItem(lines[index]!)!.indent.length < depth) return index
  return null
}

const previousSiblingRow = (lines: ReadonlyArray<string>, row: number, depth: number) => {
  for (let index = row - 1; index >= 0; index--) {
    const indent = listItem(lines[index]!)!.indent.length
    if (indent === depth) return index
    if (indent < depth) return null
  }
  return null
}

function shiftItem(lines: ReadonlyArray<string>, row: number, direction: 1 | -1): ReadonlyArray<string> {
  const item = listItem(lines[row]!)!
  const depth = item.indent.length
  let indent: string
  let marker = item.marker
  if (direction === 1) {
    const sibling = previousSiblingRow(lines, row, depth)
    if (sibling === null) return lines
    const firstChild = sibling + 1 < row ? listItem(lines[sibling + 1]!) : null
    indent = firstChild?.indent ?? " ".repeat(contentColumn(listItem(lines[sibling]!)!))
  } else {
    if (depth === 0) return lines
    const parent = parentRow(lines, row, depth)
    const parentItem = parent === null ? null : listItem(lines[parent]!)!
    indent = parentItem?.indent ?? ""
    marker = parentItem?.marker ?? marker
  }
  const end = subtreeEnd(lines, row, depth)
  return [
    ...lines.slice(0, row),
    withMarker(lines[row]!, item, indent, marker),
    ...lines.slice(row + 1, end).map((line) => indent + line.slice(depth)),
    ...lines.slice(end),
  ]
}

function replaceBlock(text: string, block: ListBlock, next: ListCaret, removed = 0): TextEdit {
  const lines = renumber(next.lines)
  const lineStart = block.from + lines.slice(0, next.row).join("\n").length + (next.row > 0 ? 1 : 0)
  const caretLine = lines[next.row]!
  const anchor = Math.max(lineStart, lineStart + (listItem(caretLine)?.prefix.length ?? 0) + next.fromPrefixEnd)
  let from = block.from
  let to = block.to + removed
  let insert = lines.join("\n")
  while (from < to && insert !== "" && text[from] === insert[0]) {
    from++
    insert = insert.slice(1)
  }
  while (from < to && insert !== "" && text[to - 1] === insert.at(-1)) {
    to--
    insert = insert.slice(0, -1)
  }
  return { from, to, insert, anchor }
}

export function continueList(text: string, from: number, to: number): TextEdit | null {
  const original = listBlockAt(text, from)
  if (original === null) return null
  const item = listItem(original.lines[original.row]!)!
  if (original.column < item.prefix.length) return null
  if (from === to && original.lines[original.row]!.slice(item.prefix.length).trim() === "") {
    const { lines, row } = original
    const nested = parentRow(lines, row, item.indent.length) !== null
    const left = nested ? shiftItem(lines, row, -1) : [...lines.slice(0, row), "", ...lines.slice(row + 1)]
    return replaceBlock(text, original, { lines: left, row, fromPrefixEnd: 0 })
  }
  const block = listBlockAt(text.slice(0, from) + text.slice(to), from)!
  const { lines, row, column } = block
  const line = lines[row]!
  const nextMarker = item.ordered ? `${Number.parseInt(item.marker) + 1}${item.kind}` : item.marker
  const nextHead = `${item.indent}${nextMarker}${item.space}${item.task ? "[ ] " : ""}`
  const nextLine = nextHead + line.slice(column)
  const split = [...lines.slice(0, row), line.slice(0, column), nextLine, ...lines.slice(row + 1)]
  const fromPrefixEnd = nextHead.length - listItem(nextLine)!.prefix.length
  return replaceBlock(text, block, { lines: split, row: row + 1, fromPrefixEnd }, to - from)
}

export function indentList(text: string, caret: number, direction: 1 | -1): TextEdit | null {
  const block = listBlockAt(text, caret)
  if (block === null) return null
  const fromPrefixEnd = block.column - listItem(block.lines[block.row]!)!.prefix.length
  const lines = shiftItem(block.lines, block.row, direction)
  return replaceBlock(text, block, { lines, row: block.row, fromPrefixEnd })
}

export function listBackspace(text: string, caret: number): TextEdit | null {
  const block = listBlockAt(text, caret)
  if (block === null) return null
  const item = listItem(block.lines[block.row]!)!
  if (block.column !== item.prefix.length) return null
  const from = caret - block.column + item.indent.length
  return { from, to: caret, insert: "", anchor: from }
}

export function highlight(text: string, known: KnownTokens): ReadonlyArray<Segment> {
  const segments: Array<Segment> = []
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) segments.push({ kind: "text", text: "\n" })
    const line = lines[index] ?? ""
    const fence = FENCE.exec(line)
    if (fence) {
      const close = lines.findIndex((next, at) => at > index && FENCE.test(next))
      const end = close === -1 ? lines.length : close
      segments.push({
        kind: "fence",
        language: fence[1] ?? "",
        open: line,
        lines: lines.slice(index + 1, end),
        close: lines[close] ?? null,
      })
      index = end
      continue
    }
    if (RULE.test(line)) {
      segments.push({ kind: "rule", text: line })
      continue
    }
    const bullet = BULLET.exec(line)
    const markerEnd = bullet ? bullet[0].length : 0
    if (bullet) segments.push({ kind: "text", text: bullet[1] ?? "" }, { kind: "bullet", text: bullet[2] ?? "" })
    segments.push(...inline(line.slice(markerEnd), known))
  }
  return merge(segments)
}

export interface CompletionQuery {
  readonly trigger: AgentCommand["trigger"] | "@" | "#"
  readonly query: string
  readonly start: number
  readonly end: number
}

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char)

const isMarkdownHeading = (trigger: string, query: string) => trigger === "#" && query.startsWith("#")

export function completionAt(text: string, caret: number): CompletionQuery | null {
  let start = caret
  while (start > 0 && !isSpace(text[start - 1])) start--
  const trigger = text[start]
  if (start === caret || (trigger !== "/" && trigger !== "$" && trigger !== "@" && trigger !== "#")) return null
  const query = text.slice(start + 1, caret)
  if (isMarkdownHeading(trigger, query)) return null
  let end = caret
  while (end < text.length && !isSpace(text[end])) end++
  return { trigger, query, start, end }
}

export function leadingSkill(text: string, commands: ReadonlyArray<AgentCommand>) {
  for (const command of commands) {
    const token = `${command.trigger}${command.name} `
    if (command.builtin !== true && text.startsWith(token)) return { command, token }
  }
  return null
}

export function matchCommands(
  commands: ReadonlyArray<AgentCommand>,
  completion: CompletionQuery & { readonly trigger: AgentCommand["trigger"] },
) {
  const query = completion.query.toLowerCase()
  const firstByName = new Map<string, AgentCommand>()
  for (const command of commands)
    if (command.trigger === completion.trigger && !firstByName.has(command.name)) firstByName.set(command.name, command)
  const candidates = [...firstByName.values()]
  const prefixed = candidates.filter((command) => command.name.toLowerCase().startsWith(query))
  const containing = candidates.filter(
    (command) => !prefixed.includes(command) && command.name.toLowerCase().includes(query),
  )
  return [...prefixed, ...containing]
}

const byLength = (a: string, b: string) => a.length - b.length

export function matchFiles(files: ReadonlyArray<string>, query: string) {
  const needle = query.toLowerCase()
  const nameStarts: Array<string> = []
  const nameContains: Array<string> = []
  const pathContains: Array<string> = []
  for (const file of files) {
    const path = file.toLowerCase()
    const name = path.slice(path.lastIndexOf("/") + 1)
    if (name.startsWith(needle)) nameStarts.push(file)
    else if (name.includes(needle)) nameContains.push(file)
    else if (path.includes(needle)) pathContains.push(file)
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- the phone runs this on Hermes, which has no `toSorted`; the arrays are local.
  return [...nameStarts.sort(byLength), ...nameContains.sort(byLength), ...pathContains.sort(byLength)]
}

export function matchThreads<T extends Pick<Thread, "title">>(threads: ReadonlyArray<T>, query: string) {
  const needle = query.toLowerCase()
  const titleStarts = threads.filter((thread) => thread.title.toLowerCase().startsWith(needle))
  const titleContains = threads.filter(
    (thread) => !titleStarts.includes(thread) && thread.title.toLowerCase().includes(needle),
  )
  return [...titleStarts, ...titleContains]
}

export interface MentionableTerminal {
  readonly session: TerminalSession
  readonly label: string
}

export function matchTerminals(terminals: ReadonlyArray<MentionableTerminal>, query: string) {
  const needle = query.toLowerCase()
  return terminals.filter((terminal) => terminal.label.toLowerCase().includes(needle))
}

export function matchPullRequests<T extends Pick<PullRequestMatch, "number" | "title">>(
  pullRequests: ReadonlyArray<T>,
  query: string,
) {
  const needle = query.toLowerCase()
  return pullRequests.filter(
    (pullRequest) => String(pullRequest.number).startsWith(needle) || pullRequest.title.toLowerCase().includes(needle),
  )
}

const MAX_SUGGESTIONS = 50

export type Suggestion =
  | { readonly type: "command"; readonly insert: string; readonly command: AgentCommand }
  | { readonly type: "file"; readonly insert: string; readonly path: string }
  | { readonly type: "thread"; readonly insert: string; readonly thread: Thread }
  | {
      readonly type: "terminal"
      readonly insert: string
      readonly session: TerminalSession
      readonly label: string
    }
  | { readonly type: "pullRequest"; readonly insert: string; readonly pullRequest: PullRequestMatch }

export const suggestionsFor = (
  completion: CompletionQuery,
  commands: ReadonlyArray<AgentCommand>,
  files: ReadonlyArray<string>,
  threads: MentionableThreads<Thread>,
  terminals: ReadonlyArray<MentionableTerminal>,
  matchedPullRequests: ReadonlyArray<PullRequestMatch>,
): ReadonlyArray<Suggestion> => {
  const { trigger } = completion
  if (trigger === "#")
    return matchedPullRequests
      .slice(0, MAX_SUGGESTIONS)
      .map((pullRequest) => ({ type: "pullRequest", insert: `#${pullRequest.number}`, pullRequest }))
  const suggestions: ReadonlyArray<Suggestion> =
    trigger === "@"
      ? [
          ...[
            ...matchThreads(threads.sameMachine, completion.query),
            ...matchThreads(threads.otherMachines, completion.query),
          ].map((thread): Suggestion => ({
            type: "thread",
            insert: threadMention(thread.id),
            thread,
          })),
          ...matchTerminals(terminals, completion.query).map(({ session, label }): Suggestion => ({
            type: "terminal",
            insert: terminalMention(session.id),
            session,
            label,
          })),
          ...matchFiles(files, completion.query).map((path): Suggestion => ({
            type: "file",
            insert: `@${path}`,
            path,
          })),
        ]
      : matchCommands(commands, { ...completion, trigger }).map((command) => ({
          type: "command",
          insert: `${command.trigger}${command.name}`,
          command,
        }))
  return suggestions.slice(0, MAX_SUGGESTIONS)
}
