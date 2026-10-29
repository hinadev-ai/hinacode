import { cp, mkdir, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
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

export type TranscriptUsage = ReadonlyMap<string, Spent>

// FIXME: the CLI writes one line per content block, each repeating the message's still-growing usage
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

const isDirectory = (path: string) =>
  stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  )

const findProjectDir = async (home: string, sessionId: string) => {
  const projects = join(home, "projects")
  const dirs = await readdir(projects).catch(() => [])
  const found = await Promise.all(dirs.map((dir) => isFile(join(projects, dir, `${sessionId}.jsonl`))))
  const index = found.indexOf(true)
  return index === -1 ? null : join(projects, dirs[index] ?? "")
}

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

export const copyTranscripts = async (sessionId: string, from: string, to: string): Promise<boolean> => {
  if (resolve(from) === resolve(to)) return true
  const projectDir = await findProjectDir(from, sessionId)
  if (projectDir === null) return false
  const target = join(to, "projects", basename(projectDir))
  await mkdir(target, { recursive: true })
  await cp(join(projectDir, `${sessionId}.jsonl`), join(target, `${sessionId}.jsonl`), { force: true })
  const agentsDir = join(projectDir, sessionId)
  if (await isDirectory(agentsDir)) await cp(agentsDir, join(target, sessionId), { recursive: true, force: true })
  return true
}
