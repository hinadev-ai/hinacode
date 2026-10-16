import { execFileSync, spawn } from "node:child_process"
import { relative } from "node:path"
import { createInterface } from "node:readline"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { FileSearchHit, ThreadSearchHit } from "../../shared/domain.ts"
import { type NotFoundError, type PersistenceError, persistence } from "./errors.ts"
import { makeActiveWorkspace } from "./workspace.ts"

export class RipgrepMissingError extends Schema.TaggedError<RipgrepMissingError>()("RipgrepMissingError", {}) {
  override get message(): string {
    return "ripgrep (rg) is not installed or not on PATH"
  }
}

const DEFAULT_LIMIT = 100
const SNIPPET_WIDTH = 80
const LINE_WIDTH = 160
const RIPGREP_TIMEOUT_MS = 3000

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * About `width` characters of `text` around the first case-insensitive occurrence of `query`, with
 * whitespace collapsed and an ellipsis where it was cut.
 */
export function snippetAround(text: string, query: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const index = Math.max(0, flat.search(new RegExp(escapeRegExp(query), "iu")))
  const start = Math.max(0, Math.min(index - Math.floor((width - query.length) / 2), flat.length - width))
  const end = Math.min(flat.length, start + width)
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`
}

/** `query` as a LIKE pattern. Escaping costs the trigram index, so it is only used when needed. */
const likePattern = (query: string) =>
  /[\\%_]/.test(query)
    ? { pattern: `%${query.replace(/[\\%_]/g, "\\$&")}%`, escaped: true }
    : { pattern: `%${query}%`, escaped: false }

function resolveRipgrep(): string | undefined {
  try {
    return execFileSync("which", ["rg"], { encoding: "utf8", timeout: 5000 }).trim() || undefined
  } catch {
    return undefined
  }
}

const RipgrepMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: Schema.Number,
    submatches: Schema.NonEmptyArray(
      Schema.Struct({ start: Schema.Number, match: Schema.Struct({ text: Schema.String }) }),
    ),
  }),
})
const decodeMatch = Schema.decodeUnknownOption(Schema.fromJsonString(RipgrepMatch))

/** One hit per matching line. Lines that are not valid UTF-8 come as `bytes` and are skipped. */
const toHit = (line: string, root: string): FileSearchHit | undefined => {
  const match = decodeMatch(line)
  if (match._tag === "None") return undefined
  const { path, lines, line_number, submatches } = match.value.data
  const text = lines.text.replace(/\r?\n$/, "")
  const [first] = submatches
  // ripgrep reports byte offsets.
  const column = Buffer.from(text).subarray(0, first.start).toString().length + 1
  return {
    path: relative(root, path.text),
    line: line_number,
    column,
    text: text.length > LINE_WIDTH ? snippetAround(text, first.match.text, LINE_WIDTH) : text.trim(),
  }
}

const runRipgrep = (rg: string, root: string, query: string, limit: number) =>
  Effect.callback<ReadonlyArray<FileSearchHit>, RipgrepMissingError>((resume) => {
    const args = ["--json", "--fixed-strings", "--smart-case", "--max-count", "50", "-e", query, "--", root]
    const child = spawn(rg, args, { stdio: ["ignore", "pipe", "ignore"] })
    const hits: Array<FileSearchHit> = []
    const lines = createInterface({ input: child.stdout })
    // Stops early on the limit or the timeout and keeps what it found, so a huge tree stays responsive.
    const finish = () => {
      clearTimeout(timer)
      lines.close()
      child.kill()
      resume(Effect.succeed(hits))
    }
    const timer = setTimeout(finish, RIPGREP_TIMEOUT_MS)
    lines.on("line", (line) => {
      const hit = toHit(line, root)
      if (hit) hits.push(hit)
      if (hits.length >= limit) finish()
    })
    child.on("close", finish)
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resume(error.code === "ENOENT" ? Effect.fail(new RipgrepMissingError()) : Effect.die(error))
    })
    return Effect.sync(() => {
      clearTimeout(timer)
      child.kill()
    })
  })

export class Search extends Context.Service<
  Search,
  {
    /** Messages containing `query` as a case-insensitive substring, newest first. */
    readonly threads: (query: string, limit?: number) => Effect.Effect<ReadonlyArray<ThreadSearchHit>, PersistenceError>
    /** Lines containing `query` literally (smart case) in the thread's active workspace. */
    readonly files: (
      threadId: string,
      query: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<FileSearchHit>, PersistenceError | NotFoundError | RipgrepMissingError>
  }
>()("hinacode/Search") {}

const ThreadRow = Schema.Struct({
  threadId: Schema.String,
  threadTitle: Schema.String,
  projectId: Schema.String,
  messageId: Schema.String,
  body: Schema.String,
  at: Schema.String,
})

/**
 * @param ripgrep finds the `rg` binary, undefined when it is not installed. Called once, on first use,
 * so installing ripgrep takes a restart.
 */
export const make = (ripgrep: () => string | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const activeWorkspace = yield* makeActiveWorkspace
    let rg: string | undefined | null = null

    const findMessages = SqlSchema.findAll({
      Request: Schema.Struct({ query: Schema.String, limit: Schema.Number }),
      Result: ThreadRow,
      execute: ({ query, limit }) => {
        const { pattern, escaped } = likePattern(query)
        return sql`
          SELECT m.thread_id, t.title AS thread_title, t.project_id, m.id AS message_id, f.body, m.created_at AS at
          FROM message_fts f
          JOIN message m ON m.rowid = f.rowid
          JOIN thread t ON t.id = m.thread_id
          WHERE f.body LIKE ${pattern} ${sql.literal(escaped ? "ESCAPE '\\'" : "")}
          ORDER BY f.rowid DESC
          LIMIT ${limit}
        `
      },
    })

    const threads = (query: string, limit = DEFAULT_LIMIT) =>
      query.trim() === ""
        ? Effect.succeed([])
        : findMessages({ query, limit }).pipe(
            Effect.map((rows) =>
              rows.map(({ body, ...hit }) => ({ ...hit, snippet: snippetAround(body, query, SNIPPET_WIDTH) })),
            ),
            Effect.mapError(persistence("search.threads")),
          )

    const files = (threadId: string, query: string, limit = DEFAULT_LIMIT) =>
      Effect.gen(function* () {
        const { cwd } = yield* activeWorkspace(threadId)
        if (query.trim() === "") return []
        if (rg === null) rg = ripgrep()
        if (rg === undefined) return yield* new RipgrepMissingError()
        return yield* runRipgrep(rg, cwd, query, limit)
      })

    return Search.of({ threads, files })
  })

export const layer = Layer.effect(Search, make(resolveRipgrep))
