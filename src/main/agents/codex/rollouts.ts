import { createReadStream } from "node:fs"
import { cp, mkdir, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { Option, Schema } from "effect"
import type { ThreadUsage } from "../../../shared/agent.ts"
import { memoizeByFile, readLines, type Tokens, toThreadUsage } from "../usage.ts"

export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex")

const OpenAiUsage = Schema.Struct({
  input_tokens: Schema.Number,
  cached_input_tokens: Schema.optional(Schema.Number),
  cache_write_input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.Number,
})
type OpenAiUsage = typeof OpenAiUsage.Type

const RolloutLine = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("turn_context"), payload: Schema.Struct({ model: Schema.String }) }),
    Schema.Struct({
      type: Schema.Literal("token_usage_record"),
      payload: Schema.Struct({ response_id: Schema.String, usage: OpenAiUsage }),
    }),
    Schema.Struct({
      type: Schema.Literal("event_msg"),
      payload: Schema.Struct({
        type: Schema.Literal("token_count"),
        info: Schema.NullOr(Schema.Struct({ total_token_usage: OpenAiUsage })),
      }),
    }),
  ]),
)
const decodeRolloutLine = Schema.decodeUnknownOption(RolloutLine)

const SessionMetaLine = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("session_meta"),
    payload: Schema.Struct({ id: Schema.String, session_id: Schema.optional(Schema.String) }),
  }),
)
const decodeSessionMetaLine = Schema.decodeUnknownOption(SessionMetaLine)

/** OpenAI counts cached input inside `input_tokens`, and reasoning inside `output_tokens`. */
const toTokens = (usage: OpenAiUsage): Tokens => {
  const cacheReadTokens = usage.cached_input_tokens ?? 0
  const cacheWriteTokens = usage.cache_write_input_tokens ?? 0
  return {
    inputTokens: Math.max(0, usage.input_tokens - cacheReadTokens - cacheWriteTokens),
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens: usage.output_tokens,
  }
}

const total = (usage: OpenAiUsage) => usage.input_tokens + usage.output_tokens

const minus = (a: OpenAiUsage, b: OpenAiUsage): OpenAiUsage => ({
  input_tokens: a.input_tokens - b.input_tokens,
  cached_input_tokens: (a.cached_input_tokens ?? 0) - (b.cached_input_tokens ?? 0),
  cache_write_input_tokens: (a.cache_write_input_tokens ?? 0) - (b.cache_write_input_tokens ?? 0),
  output_tokens: a.output_tokens - b.output_tokens,
})

interface Spent {
  readonly model: string
  readonly tokens: Tokens
}

const RELEVANT = ['"turn_context"', '"token_usage_record"', '"token_count"']

/**
 * Tokens one rollout spent, each attributed to the model of the latest `turn_context`.
 *
 * Newer Codex writes a `token_usage_record` per model response, which is used when present. Older rollouts
 * only have `token_count`, whose cumulative total repeats and at times restarts from zero, so those count the
 * growth between totals. Totals leave out compaction requests, so they undercount slightly.
 */
export const parseRollout = async (lines: AsyncIterable<string> | Iterable<string>): Promise<ReadonlyArray<Spent>> => {
  let model = "unknown"
  const records = new Map<string, Spent>()
  const counted: Array<Spent> = []
  let previous: OpenAiUsage | null = null
  for await (const line of lines) {
    if (!RELEVANT.some((type) => line.includes(type))) continue
    const decoded = decodeRolloutLine(line)
    if (Option.isNone(decoded)) continue
    const { type, payload } = decoded.value
    if (type === "turn_context") model = payload.model
    else if (type === "token_usage_record") records.set(payload.response_id, { model, tokens: toTokens(payload.usage) })
    else if (payload.info !== null) {
      const current = payload.info.total_token_usage
      const grown = previous !== null && total(current) >= total(previous) ? minus(current, previous) : current
      if (total(grown) > 0) counted.push({ model, tokens: toTokens(grown) })
      previous = current
    }
  }
  return records.size > 0 ? [...records.values()] : counted
}

/** Only the first line, since a rollout's session_meta carries the full base instructions after it. */
const readFirstLine = async (path: string) => {
  let line = ""
  for await (const chunk of createReadStream(path, "utf8")) {
    const text: string = chunk
    const end = text.indexOf("\n")
    if (end !== -1) return line + text.slice(0, end)
    line += text
  }
  return line
}

/** `rollout-2026-09-22T11-35-55-<id>.jsonl` sorts by when the rollout started. */
const startedAt = (path: string) => basename(path).slice("rollout-".length, "rollout-".length + 19)

const readSessionId = (path: string) =>
  readFirstLine(path).then(
    (line) => Option.getOrNull(decodeSessionMetaLine(line))?.payload.session_id ?? null,
    () => null,
  )

/**
 * A Codex thread's rollouts under `home`, its own first. Sub-agents get rollouts of their own whose
 * session_meta names the root thread as `session_id`, and they always start after it. Empty when the thread
 * has no rollout.
 */
export const findRollouts = async (
  home: string,
  threadId: string,
  sessionIdOf: (path: string) => Promise<string | null> = readSessionId,
): Promise<ReadonlyArray<string>> => {
  const sessions = join(home, "sessions")
  const rollouts = (await readdir(sessions, { recursive: true }).catch(() => []))
    .filter((name) => basename(name).startsWith("rollout-") && name.endsWith(".jsonl"))
    .map((name) => join(sessions, name))
  const root = rollouts.find((path) => path.endsWith(`-${threadId}.jsonl`))
  if (root === undefined) return []

  const later = rollouts.filter((path) => path !== root && startedAt(path) >= startedAt(root))
  const owners = await Promise.all(later.map(sessionIdOf))
  return [root, ...later.filter((_, index) => owners[index] === threadId)]
}

/** Reads a Codex thread's tokens from its rollouts under `home`, sub-agents' included. */
export const makeRolloutUsage = (home: string) => {
  const parse = memoizeByFile((path) => parseRollout(readLines(path)))
  // A rollout's first line never changes.
  const sessionIds = new Map<string, Promise<string | null>>()
  const sessionIdOf = (path: string) => {
    const cached = sessionIds.get(path)
    if (cached !== undefined) return cached
    const read = readSessionId(path)
    sessionIds.set(path, read)
    return read
  }

  return async (threadId: string): Promise<ThreadUsage | null> => {
    const rollouts = await findRollouts(home, threadId, sessionIdOf)
    if (rollouts.length === 0) return null

    const parsed = await Promise.all(rollouts.map((path) => parse(path).catch(() => null)))
    if (parsed[0] === null) return null
    const found = parsed.filter((spent) => spent !== null)
    return toThreadUsage(found.flat(), found.length)
  }
}

/**
 * Copies a Codex thread's rollouts and its sub-agents' from one Codex home to another, at the same paths,
 * overwriting older copies. False when `from` has no rollout for the thread.
 */
export const copyRollouts = async (threadId: string, from: string, to: string): Promise<boolean> => {
  if (resolve(from) === resolve(to)) return true
  const rollouts = await findRollouts(from, threadId)
  if (rollouts.length === 0) return false
  for (const path of rollouts) {
    const target = join(to, relative(from, path))
    await mkdir(dirname(target), { recursive: true })
    await cp(path, target, { force: true })
  }
  return true
}
