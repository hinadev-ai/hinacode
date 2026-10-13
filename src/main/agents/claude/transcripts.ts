import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Option, Schema } from "effect"
import type { ThreadUsage } from "../../../shared/agent.ts"
import { memoizeByFile, readLines, type Tokens, toThreadUsage } from "../usage.ts"

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")

const AssistantLine = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("assistant"),
    requestId: Schema.optional(Schema.String),
    message: Schema.Struct({
      id: Schema.String,
      model: Schema.String,
      usage: Schema.Struct({
        input_tokens: Schema.Number,
        cache_creation_input_tokens: Schema.optional(Schema.Number),
        cache_read_input_tokens: Schema.optional(Schema.Number),
        output_tokens: Schema.Number,
      }),
    }),
  }),
)
const decodeAssistantLine = Schema.decodeUnknownOption(AssistantLine)

interface Spent {
  readonly model: string
  readonly tokens: Tokens
}

/** One model request's usage, keyed by message and request id. */
export type TranscriptUsage = ReadonlyMap<string, Spent>

/**
 * The CLI writes one line per content block, each repeating the message's usage, and the output count
 * keeps growing until the last block. Keeping the largest count per message counts each request once.
 */
const keepLatest = (into: Map<string, Spent>, key: string, spent: Spent) => {
  const seen = into.get(key)
  if (seen === undefined || spent.tokens.outputTokens > seen.tokens.outputTokens) into.set(key, spent)
}

export const parseTranscript = async (lines: AsyncIterable<string> | Iterable<string>): Promise<TranscriptUsage> => {
  const requests = new Map<string, Spent>()
  for await (const line of lines) {
    if (!line.includes('"assistant"')) continue
    const decoded = decodeAssistantLine(line)
    if (Option.isNone(decoded)) continue
    const { requestId, message } = decoded.value
    if (message.model === "<synthetic>") continue
    keepLatest(requests, `${message.id}:${requestId ?? ""}`, {
      model: message.model,
      tokens: {
        inputTokens: message.usage.input_tokens,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        outputTokens: message.usage.output_tokens,
      },
    })
  }
  return requests
}

const isFile = (path: string) =>
  stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  )

/**
 * The folder under `<home>/projects` holding the session. Scanned instead of derived from the session's
 * cwd, so the CLI's path encoding never has to be copied.
 */
const findProjectDir = async (home: string, sessionId: string) => {
  const projects = join(home, "projects")
  const dirs = await readdir(projects).catch(() => [])
  const found = await Promise.all(dirs.map((dir) => isFile(join(projects, dir, `${sessionId}.jsonl`))))
  const index = found.indexOf(true)
  return index === -1 ? null : join(projects, dirs[index] ?? "")
}

/**
 * Reads a Claude session's tokens from its transcripts under `home`: the main session plus every agent
 * transcript beneath `<sessionId>/`. Workflow agents sit in `subagents/workflows/<run>/`, so the folder is
 * read recursively.
 */
export const makeTranscriptUsage = (home: string) => {
  const parse = memoizeByFile((path) => parseTranscript(readLines(path)))
  const projectDirs = new Map<string, string>()

  return async (sessionId: string): Promise<ThreadUsage | null> => {
    const projectDir = projectDirs.get(sessionId) ?? (await findProjectDir(home, sessionId))
    if (projectDir === null) return null
    projectDirs.set(sessionId, projectDir)

    const main = join(projectDir, `${sessionId}.jsonl`)
    const agentsDir = join(projectDir, sessionId)
    const agents = (await readdir(agentsDir, { recursive: true }).catch(() => []))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(agentsDir, name))

    const parsed = await Promise.all([main, ...agents].map((path) => parse(path).catch(() => null)))
    if (parsed[0] === null) {
      projectDirs.delete(sessionId)
      return null
    }
    const requests = new Map<string, Spent>()
    for (const transcript of parsed) {
      for (const [key, spent] of transcript ?? []) keepLatest(requests, key, spent)
    }
    return toThreadUsage(requests.values(), parsed.filter((transcript) => transcript !== null).length)
  }
}
