import { execFileSync, spawn } from "node:child_process"
import { relative } from "node:path"
import { createInterface } from "node:readline"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { FileSearchHit, ThreadSearchHit } from "../../shared/domain.ts"
import { type FolderMissingError, type NotFoundError, type PersistenceError, persistence } from "./errors.ts"
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

export function snippetAround(text: string, query: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const index = Math.max(0, flat.search(new RegExp(escapeRegExp(query), "iu")))
  const start = Math.max(0, Math.min(index - Math.floor((width - query.length) / 2), flat.length - width))
  const end = Math.min(flat.length, start + width)
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`
}

const likePattern = (query: string) =>
  /[\\%_]/.test(query)
    ? { pattern: `%${query.replace(/[\\%_]/g, "\\$&")}%`, escaped: true }
    : { pattern: `%${query}%`, escaped: false }

const ftsPhrase = (query: string) => `"${query.replaceAll('"', '""')}"`

const CJK_CHAR = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]`
const CJK_RUN = new RegExp(`${CJK_CHAR}+`, "gu")
const CJK_ONLY = new RegExp(`^${CJK_CHAR}+$`, "u")

const cjkGrams = (text: string): string =>
  Array.from(text.matchAll(CJK_RUN), ([run]) => {
    const chars = [...run]
    const bigrams = chars.slice(1).map((char, index) => chars[index] + char)
    return [...chars, ...bigrams].join(" ")
  }).join(" ")

const matchKind = (query: string) =>
  [...query].length >= 3 ? "trigram" : CJK_ONLY.test(query) ? "cjkGrams" : "likeScan"

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

const toHit = (line: string, root: string): FileSearchHit | undefined => {
  const match = decodeMatch(line)
  if (match._tag === "None") return undefined
  const { path, lines, line_number, submatches } = match.value.data
  const text = lines.text.replace(/\r?\n$/, "")
  const [first] = submatches
  // FIXME: ripgrep reports byte offsets
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

export interface PerThreadOptions {
  readonly limit: number
  readonly threadIds?: ReadonlyArray<string>
}

export class Search extends Context.Service<
  Search,
  {
    readonly threads: (query: string, limit?: number) => Effect.Effect<ReadonlyArray<ThreadSearchHit>, PersistenceError>
    readonly perThread: (
      query: string,
      options: PerThreadOptions,
    ) => Effect.Effect<ReadonlyArray<ThreadSearchHit>, PersistenceError>
    readonly files: (
      threadId: string,
      query: string,
      limit?: number,
    ) => Effect.Effect<
      ReadonlyArray<FileSearchHit>,
      PersistenceError | NotFoundError | FolderMissingError | RipgrepMissingError
    >
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

export const make = (ripgrep: () => string | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const activeWorkspace = yield* makeActiveWorkspace
    let rg: string | undefined | null = null

    const matching = (query: string) => {
      switch (matchKind(query)) {
        case "trigram":
          return sql`f.body MATCH ${ftsPhrase(query)}`
        case "cjkGrams":
          return sql`f.rowid IN (SELECT rowid FROM message_cjk WHERE grams MATCH ${ftsPhrase(query)})`
        case "likeScan": {
          const { pattern, escaped } = likePattern(query)
          return sql`f.body LIKE ${pattern} ${sql.literal(escaped ? "ESCAPE '\\'" : "")}`
        }
      }
    }

    const indexStaleCjk = sql.withTransaction(
      Effect.gen(function* () {
        const stale = yield* sql<{ readonly rowid: number; readonly body: string | null }>`
          SELECT s.rowid, f.body FROM message_cjk_stale s LEFT JOIN message_fts f ON f.rowid = s.rowid
        `
        if (stale.length === 0) return
        yield* sql`DELETE FROM message_cjk WHERE rowid IN (SELECT rowid FROM message_cjk_stale)`
        for (const { rowid, body } of stale) {
          const grams = cjkGrams(body ?? "")
          if (grams !== "") yield* sql`INSERT INTO message_cjk(rowid, grams) VALUES (${rowid}, ${grams})`
        }
        yield* sql`DELETE FROM message_cjk_stale`
      }),
    )

    const indexedFor = (query: string) => (matchKind(query) === "cjkGrams" ? indexStaleCjk : Effect.void)

    const findMessages = SqlSchema.findAll({
      Request: Schema.Struct({ query: Schema.String, limit: Schema.Number }),
      Result: ThreadRow,
      execute: ({ query, limit }) =>
        sql`
          SELECT m.thread_id, t.title AS thread_title, t.project_id, m.id AS message_id, f.body, m.created_at AS at
          FROM message_fts f
          JOIN message m ON m.rowid = f.rowid
          JOIN thread t ON t.id = m.thread_id
          WHERE ${matching(query)} AND t.side_of IS NULL
          ORDER BY f.rowid DESC
          LIMIT ${limit}
        `,
    })

    const findNewestPerThread = SqlSchema.findAll({
      Request: Schema.Struct({
        query: Schema.String,
        limit: Schema.Number,
        threadIds: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      Result: ThreadRow,
      execute: ({ query, limit, threadIds }) => {
        const inThreads = threadIds === undefined ? sql.literal("") : sql`AND ${sql.in("m.thread_id", threadIds)}`
        return sql`
          SELECT thread_id, thread_title, project_id, message_id, body, at FROM (
            SELECT m.thread_id, t.title AS thread_title, t.project_id, m.id AS message_id, f.body, m.created_at AS at,
              f.rowid AS position,
              ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.created_at DESC, f.rowid DESC) AS rank
            FROM message_fts f
            JOIN message m ON m.rowid = f.rowid
            JOIN thread t ON t.id = m.thread_id
            WHERE ${matching(query)} AND t.side_of IS NULL ${inThreads}
          )
          WHERE rank = 1
          ORDER BY at DESC, position DESC
          LIMIT ${limit}
        `
      },
    })

    const withSnippet = (query: string) => (rows: ReadonlyArray<typeof ThreadRow.Type>) =>
      rows.map(({ body, ...hit }) => ({ ...hit, snippet: snippetAround(body, query, SNIPPET_WIDTH) }))

    const threads = (query: string, limit = DEFAULT_LIMIT) =>
      query.trim() === ""
        ? Effect.succeed([])
        : indexedFor(query).pipe(
            Effect.andThen(findMessages({ query, limit })),
            Effect.map(withSnippet(query)),
            Effect.mapError(persistence("search.threads")),
          )

    const perThread = (query: string, options: PerThreadOptions) =>
      query.trim() === "" || options.threadIds?.length === 0
        ? Effect.succeed([])
        : indexedFor(query).pipe(
            Effect.andThen(findNewestPerThread({ query, ...options })),
            Effect.map(withSnippet(query)),
            Effect.mapError(persistence("search.perThread")),
          )

    const files = (threadId: string, query: string, limit = DEFAULT_LIMIT) =>
      Effect.gen(function* () {
        const { cwd } = yield* activeWorkspace(threadId)
        if (query.trim() === "") return []
        if (rg === null) rg = ripgrep()
        if (rg === undefined) return yield* new RipgrepMissingError()
        return yield* runRipgrep(rg, cwd, query, limit)
      })

    return Search.of({ threads, perThread, files })
  })

export const layer = Layer.effect(Search, make(resolveRipgrep))
