import type { AgentCommand } from "./agent.ts"
import type { Thread } from "./domain.ts"
import { mentionedThreadId, threadMention } from "./threadMention.ts"

export type SyntaxKind = "text" | "bullet" | "code" | "command" | "mention"

/** Tokens worth coloring: full command tokens such as `/review`, and workspace file paths and thread ids for `@` mentions. */
export interface KnownTokens {
  readonly commands: ReadonlySet<string>
  readonly files: ReadonlySet<string>
  readonly threads: ReadonlySet<string>
}

export interface Segment {
  readonly kind: SyntaxKind
  readonly text: string
}

const FENCE = /^\s*```/
const BULLET = /^(\s*)([-*+]|\d+[.)])(?=\s)/
/** Inline code, or a `/command`, `$skill` or `@file` token that starts the line or follows whitespace. */
const INLINE = /`[^`\n]+`|(?<=^|\s)[/$@][^\s]+/g
/** Prose punctuation right after a mention, as in "see @src/a.ts, then". */
const TRAILING_PUNCTUATION = /[,.;:!?)\]]+$/

const classify = (token: string, known: KnownTokens): { kind: SyntaxKind; text: string } | null => {
  if (token.startsWith("`")) return { kind: "code", text: token }
  if (token.startsWith("@")) {
    const mention = token.replace(TRAILING_PUNCTUATION, "")
    const threadId = mentionedThreadId(mention)
    const isKnown = threadId === null ? known.files.has(mention.slice(1)) : known.threads.has(threadId)
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
    if (segment.text === "") return merged
    const previous = merged.at(-1)
    if (previous?.kind === segment.kind)
      merged[merged.length - 1] = { kind: segment.kind, text: previous.text + segment.text }
    else merged.push(segment)
    return merged
  }, [])

/**
 * Splits composer text into the spans the composer colors: list markers, inline and fenced code, known
 * commands and mentions of known files. Joining the spans gives back `text`, so the result can sit under
 * the textarea character for character.
 */
export function highlight(text: string, known: KnownTokens): ReadonlyArray<Segment> {
  const segments: Array<Segment> = []
  let inFence = false
  text.split("\n").forEach((line, index) => {
    if (index > 0) segments.push({ kind: inFence ? "code" : "text", text: "\n" })
    if (FENCE.test(line)) {
      inFence = !inFence
      segments.push({ kind: "code", text: line })
      return
    }
    if (inFence) {
      segments.push({ kind: "code", text: line })
      return
    }
    const bullet = BULLET.exec(line)
    const markerEnd = bullet ? bullet[0].length : 0
    if (bullet) segments.push({ kind: "text", text: bullet[1] ?? "" }, { kind: "bullet", text: bullet[2] ?? "" })
    segments.push(...inline(line.slice(markerEnd), known))
  })
  return merge(segments)
}

export interface CompletionQuery {
  /** `@` mentions a file or a thread; the others are the agent's command triggers. */
  readonly trigger: AgentCommand["trigger"] | "@"
  /** What has been typed after the trigger, up to the caret. */
  readonly query: string
  /** The whole token around the caret, which a picked command replaces. */
  readonly start: number
  readonly end: number
}

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char)

/** The `/command`, `$skill` or `@mention` token the caret is in, if it starts the line or follows whitespace. */
export function completionAt(text: string, caret: number): CompletionQuery | null {
  let start = caret
  while (start > 0 && !isSpace(text[start - 1])) start--
  const trigger = text[start]
  if (start === caret || (trigger !== "/" && trigger !== "$" && trigger !== "@")) return null
  let end = caret
  while (end < text.length && !isSpace(text[end])) end++
  return { trigger, query: text.slice(start + 1, caret), start, end }
}

/** Commands for `completion`, names starting with the query first, then names containing it. */
export function matchCommands(
  commands: ReadonlyArray<AgentCommand>,
  completion: CompletionQuery & { readonly trigger: AgentCommand["trigger"] },
) {
  const query = completion.query.toLowerCase()
  const candidates = commands.filter((command) => command.trigger === completion.trigger)
  const prefixed = candidates.filter((command) => command.name.toLowerCase().startsWith(query))
  const containing = candidates.filter(
    (command) => !prefixed.includes(command) && command.name.toLowerCase().includes(query),
  )
  return [...prefixed, ...containing]
}

const byLength = (a: string, b: string) => a.length - b.length

/** Files whose name starts with `query`, then whose name contains it, then whose path does; shortest first in each. */
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
  return [...nameStarts.toSorted(byLength), ...nameContains.toSorted(byLength), ...pathContains.toSorted(byLength)]
}

/** Threads whose title starts with `query`, then whose title contains it, each in the given order. */
export function matchThreads<T extends Pick<Thread, "title">>(threads: ReadonlyArray<T>, query: string) {
  const needle = query.toLowerCase()
  const titleStarts = threads.filter((thread) => thread.title.toLowerCase().startsWith(needle))
  const titleContains = threads.filter(
    (thread) => !titleStarts.includes(thread) && thread.title.toLowerCase().includes(needle),
  )
  return [...titleStarts, ...titleContains]
}

const MAX_SUGGESTIONS = 50

/** One row of the completion list. `insert` replaces the token at the caret. */
export type Suggestion =
  | { readonly type: "command"; readonly insert: string; readonly command: AgentCommand }
  | { readonly type: "file"; readonly insert: string; readonly path: string }
  | { readonly type: "thread"; readonly insert: string; readonly thread: Thread }

/** Threads then files for `@`, else the commands of the typed trigger, at most `MAX_SUGGESTIONS`. */
export const suggestionsFor = (
  completion: CompletionQuery,
  commands: ReadonlyArray<AgentCommand>,
  files: ReadonlyArray<string>,
  threads: ReadonlyArray<Thread>,
): ReadonlyArray<Suggestion> => {
  const { trigger } = completion
  const suggestions: ReadonlyArray<Suggestion> =
    trigger === "@"
      ? [
          ...matchThreads(threads, completion.query).map((thread): Suggestion => ({
            type: "thread",
            insert: threadMention(thread.id),
            thread,
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
