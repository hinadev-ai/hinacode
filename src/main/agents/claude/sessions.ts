import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { listSessions, type SessionStore } from "@anthropic-ai/claude-agent-sdk"
import { Option, Schema } from "effect"
import { makeTranscriptBuilder } from "../importTranscript.ts"
import { LISTED_SESSIONS, type NativeSession, type SessionHistory } from "../provider.ts"

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const PREVIEW_LENGTH = 300

type Entry = {
  readonly type: string
  readonly uuid?: string
  readonly timestamp?: string
  readonly [k: string]: unknown
}

const parseEntries = (text: string): Array<Entry> =>
  text.split("\n").flatMap((line) => {
    if (line.trim() === "") return []
    try {
      const entry: unknown = JSON.parse(line)
      return typeof entry === "object" && entry !== null && "type" in entry ? [entry as Entry] : []
    } catch {
      return []
    }
  })

// FIXME: the SDK reads only the config dir the process started with, so a store over `home` reaches other accounts.
const homeStore = (home: string): SessionStore => ({
  append: () => Promise.reject(new Error("Read only")),
  load: ({ projectKey, sessionId }) =>
    readFile(join(home, "projects", projectKey, `${sessionId}.jsonl`), "utf8").then(
      (text) => parseEntries(text),
      () => null,
    ),
  listSessions: async (projectKey) => {
    const dir = join(home, "projects", projectKey)
    const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".jsonl"))
    const listed = await Promise.all(
      names.map((name) =>
        stat(join(dir, name)).then(
          (stats) => ({ sessionId: name.slice(0, -".jsonl".length), mtime: Math.floor(stats.mtimeMs) }),
          () => null,
        ),
      ),
    )
    return listed.filter((session) => session !== null)
  },
})

const shorten = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}

export const listClaudeSessions = async (home: string, cwd: string): Promise<ReadonlyArray<NativeSession>> => {
  const sessions = await listSessions({ dir: cwd, sessionStore: homeStore(home), limit: LISTED_SESSIONS })
  return sessions
    .filter((session) => session.cwd === undefined || session.cwd === cwd)
    .map((session) => ({
      sessionId: session.sessionId,
      title: shorten(session.summary, 120),
      preview: shorten(session.firstPrompt ?? "", PREVIEW_LENGTH),
      branch: session.gitBranch ?? null,
      updatedAt: new Date(session.lastModified).toISOString(),
    }))
}

const ContentBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool_use"), id: Schema.String, name: Schema.String, input: Schema.Unknown }),
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    tool_use_id: Schema.String,
    content: Schema.optional(Schema.Unknown),
    is_error: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("image") }),
  Schema.Struct({ type: Schema.Literal("redacted_thinking") }),
])
type ContentBlock = typeof ContentBlock.Type

const TranscriptLine = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["user", "assistant"]),
    uuid: Schema.String,
    timestamp: Schema.String,
    isMeta: Schema.optional(Schema.Boolean),
    isCompactSummary: Schema.optional(Schema.Boolean),
    message: Schema.Struct({
      model: Schema.optional(Schema.String),
      content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("compact_boundary"),
    timestamp: Schema.String,
    compactMetadata: Schema.optional(
      Schema.Struct({
        trigger: Schema.Literals(["manual", "auto"]),
        preTokens: Schema.optional(Schema.Number),
        postTokens: Schema.optional(Schema.Number),
      }),
    ),
  }),
])
const decodeLine = Schema.decodeUnknownOption(TranscriptLine)
const decodeBlock = Schema.decodeUnknownOption(ContentBlock)

const blocksOf = (content: string | ReadonlyArray<unknown>): ReadonlyArray<ContentBlock> =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : content.flatMap((block) => Option.toArray(decodeBlock(block)))

const currentBranch = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> => {
  const byUuid = new Map<string, Entry>()
  for (const entry of entries) if (typeof entry.uuid === "string") byUuid.set(entry.uuid, entry)
  const leaf = entries.findLast(
    (entry) => (entry.type === "user" || entry.type === "assistant") && entry.isSidechain !== true,
  )
  const branch: Array<Entry> = []
  const seen = new Set<string>()
  for (let entry = leaf; entry?.uuid !== undefined;) {
    if (seen.has(entry.uuid)) throw new Error(`Claude transcript loops back to ${entry.uuid}`)
    seen.add(entry.uuid)
    branch.push(entry)
    const parent = entry.parentUuid ?? entry.logicalParentUuid
    if (typeof parent !== "string") break
    const next = byUuid.get(parent)
    if (next === undefined && typeof entry.parentUuid === "string") {
      throw new Error(`Claude transcript is missing ${parent}`)
    }
    entry = next
  }
  return branch.toReversed()
}

const COMMAND = /<command-name>(.*?)<\/command-name>[\s\S]*?(?:<command-args>([\s\S]*?)<\/command-args>|$)/
const LOCAL_OUTPUT = /^<(local-command-stdout|local-command-stderr|local-command-caveat)>/
const INTERRUPTED = /^\[Request interrupted by user/
const TASK_NOTIFICATION = /^<task-notification>/

const promptText = (text: string) => {
  const command = COMMAND.exec(text)
  if (command === null) return text
  const args = command[2]?.trim() ?? ""
  return args === "" ? (command[1] ?? "") : `${command[1]} ${args}`
}

const titleOf = (entries: ReadonlyArray<Entry>) => {
  const named = (type: string, key: string) => {
    const value = entries.findLast((entry) => entry.type === type)?.[key]
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null
  }
  return named("custom-title", "customTitle") ?? named("ai-title", "aiTitle")
}

export const toImportedHistory = (sessionId: string, entries: ReadonlyArray<Entry>): SessionHistory => {
  const transcript = makeTranscriptBuilder()
  const pendingEdits = new Map<string, string>()
  let model: string | null = null

  for (const entry of currentBranch(entries)) {
    const decoded = decodeLine(entry)
    if (Option.isNone(decoded)) continue
    const line = decoded.value
    if (line.type === "system") {
      transcript.event(
        {
          type: "compaction_updated",
          compaction: {
            status: "done",
            trigger: line.compactMetadata?.trigger ?? "auto",
            preTokens: line.compactMetadata?.preTokens ?? null,
            postTokens: line.compactMetadata?.postTokens ?? null,
          },
        },
        line.timestamp,
      )
      continue
    }
    if (line.isMeta === true || line.isCompactSummary === true) continue
    const at = line.timestamp
    const blocks = blocksOf(line.message.content)

    if (line.type === "assistant") {
      if (line.message.model !== undefined && line.message.model !== "<synthetic>") model = line.message.model
      for (const block of blocks) {
        if (block.type === "text") transcript.event({ type: "text_delta", text: block.text }, at)
        if (block.type === "thinking" && block.thinking !== "")
          transcript.event({ type: "reasoning_delta", text: block.thinking }, at)
        if (block.type === "tool_use") {
          const input = block.input as Record<string, unknown> | null
          const path = input?.file_path ?? input?.notebook_path
          if (FILE_EDIT_TOOLS.has(block.name) && typeof path === "string") pendingEdits.set(block.id, path)
          transcript.event({ type: "tool_call_started", callId: block.id, name: block.name, input: block.input }, at)
        }
      }
      transcript.reachedForkPoint({ sessionId, checkpoint: line.uuid })
      continue
    }

    const results = blocks.filter((block) => block.type === "tool_result")
    for (const result of results) {
      const isError = result.is_error ?? false
      transcript.event({ type: "tool_call_finished", callId: result.tool_use_id, output: result.content, isError }, at)
      const path = pendingEdits.get(result.tool_use_id)
      pendingEdits.delete(result.tool_use_id)
      if (path !== undefined && !isError) transcript.event({ type: "file_changed", path }, at)
    }
    if (results.length > 0) continue

    const text = blocks
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim()
    if (text === "" || LOCAL_OUTPUT.test(text) || INTERRUPTED.test(text)) continue
    if (TASK_NOTIFICATION.test(text)) transcript.endTurn()
    else transcript.prompt(promptText(text), at)
  }
  return { title: titleOf(entries), model, messages: transcript.finish() }
}

const findTranscript = async (home: string, cwd: string, sessionId: string) => {
  const projects = join(home, "projects")
  for (const dir of await readdir(projects).catch(() => [])) {
    const text = await readFile(join(projects, dir, `${sessionId}.jsonl`), "utf8").catch(() => null)
    if (text === null) continue
    const entries = parseEntries(text)
    if (entries.some((entry) => entry.cwd === cwd)) return entries
  }
  return null
}

export const readClaudeSession = async (home: string, cwd: string, sessionId: string): Promise<SessionHistory> => {
  const entries = await findTranscript(home, cwd, sessionId)
  if (entries === null) throw new Error(`Claude session ${sessionId} is no longer in ${home}`)
  try {
    const history = toImportedHistory(sessionId, entries)
    return history.messages?.length === 0 ? { ...history, messages: null } : history
  } catch {
    return { title: null, model: null, messages: null }
  }
}
