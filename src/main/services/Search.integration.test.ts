import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, type FileSystem, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { MessagePart } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import ftsToolTitles from "../db/migrations/0034_fts_tool_titles.ts"
import { seedThread } from "../db/testing.ts"
import * as Search from "./Search.ts"

let repo = ""

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "kk-search-test-"))
  execFileSync("git", ["init", "-q", repo])
  mkdirSync(join(repo, "src"))
  writeFileSync(join(repo, "src", "Worktrees.ts"), "export const a = 1\n// 遷移 then createWorktree here\n")
  writeFileSync(join(repo, "README.md"), "Call createWorktree first.\n")
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n")
  writeFileSync(join(repo, "ignored.txt"), "createWorktree\n")
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

const withSearch = (layer: Layer.Layer<Search.Search, never, SqlClient.SqlClient | FileSystem.FileSystem>) =>
  Effect.provide(layer.pipe(Layer.provideMerge(Db.layer(":memory:")), Layer.provide(NodeServices.layer)))

let clock = 0
const insertMessage = (threadId: string, parts: ReadonlyArray<MessagePart>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const id = `m${++clock}`
    const at = new Date(Date.UTC(2026, 9, 12, 0, 0, clock)).toISOString()
    yield* sql`INSERT INTO message ${sql.insert({
      id,
      threadId,
      role: "assistant",
      parts: JSON.stringify(parts),
      createdAt: at,
      completedAt: at,
    })}`
    return id
  })

const text = (value: string): MessagePart => ({ type: "text", text: value })
const call = (callId: string, name: string, input: unknown): MessagePart => ({
  type: "tool_call",
  callId,
  name,
  input,
  status: "done",
})

describe("Search.threads", () => {
  it.effect("finds substrings case-insensitively, newest first, with a snippet around the match", () =>
    Effect.gen(function* () {
      const { threadId, projectId } = yield* seedThread({ rootPath: repo })
      const older = yield* insertMessage(threadId, [text("Ran the MIGRATION for worktrees")])
      yield* insertMessage(threadId, [text("nothing to see")])
      const newer = yield* insertMessage(threadId, [
        text(`${"x ".repeat(100)}then the migration passed${" y".repeat(100)}`),
      ])
      const search = yield* Search.Search

      const hits = yield* search.threads("Migration")
      expect(hits.map((hit) => hit.messageId)).toStrictEqual([newer, older])
      expect(hits[0]).toMatchObject({ threadId, threadTitle: "t", projectId })
      expect(hits[0]?.snippet).toMatch(/^….*then the migration passed.*…$/)
      expect(hits[0]?.snippet.length).toBeLessThanOrEqual(82)
      expect(hits[1]?.snippet).toBe("Ran the MIGRATION for worktrees")
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("snippets the occurrence that matched, deep inside a long message", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: repo })
      yield* insertMessage(threadId, [
        text(`an agent\nStatus line${"\n  filler line".repeat(20_000)}\nthen the agent sets up the project\n\n\nend`),
      ])
      const search = yield* Search.Search

      const [hit] = yield* search.threads("agent s")
      expect(hit?.snippet).toMatch(/^….* then the agent sets up the project end$/)
      expect(hit?.snippet.length).toBeLessThanOrEqual(81)
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("perThread keeps an older thread that a busy thread would push past the limit", () =>
    Effect.gen(function* () {
      const quiet = (yield* seedThread({ rootPath: repo })).threadId
      const busy = (yield* seedThread({ rootPath: `${repo}-busy` })).threadId
      const quietHit = yield* insertMessage(quiet, [text("the deploy failed once")])
      for (let index = 0; index < 5; index++) yield* insertMessage(busy, [text(`deploy attempt ${index}`)])
      const busyHit = yield* insertMessage(busy, [text("deploy attempt final")])
      const search = yield* Search.Search

      expect((yield* search.threads("deploy", 3)).map((hit) => hit.threadId)).toStrictEqual([busy, busy, busy])
      const hits = yield* search.perThread("Deploy", { limit: 3 })
      expect(hits.map((hit) => [hit.threadId, hit.messageId])).toStrictEqual([
        [busy, busyHit],
        [quiet, quietHit],
      ])
      expect(hits[0]?.snippet).toBe("deploy attempt final")
      const onlyQuiet = yield* search.perThread("deploy", { limit: 3, threadIds: [quiet] })
      expect(onlyQuiet.map((hit) => hit.messageId)).toStrictEqual([quietHit])
      expect(yield* search.perThread("deploy", { limit: 3, threadIds: [] })).toStrictEqual([])
      expect(yield* search.perThread(" ", { limit: 3 })).toStrictEqual([])
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("perThread ranks by when a message was written, not when it was stored", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const recent = (yield* seedThread({ rootPath: `${repo}-recent` })).threadId
      const imported = (yield* seedThread({ rootPath: `${repo}-imported` })).threadId
      yield* insertMessage(recent, [text("the invoice job ran")])
      const old = yield* insertMessage(imported, [text("the invoice job ran last year")])
      yield* sql`UPDATE message SET created_at = '2025-01-01T00:00:00.000Z' WHERE id = ${old}`
      const search = yield* Search.Search

      expect((yield* search.perThread("invoice", { limit: 1 })).map((hit) => hit.threadId)).toStrictEqual([recent])
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("searches what the transcript shows: text, tool summaries and file paths, not output or reasoning", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: repo })
      const tool = yield* insertMessage(threadId, [
        { type: "reasoning", text: "secret plan" },
        {
          type: "tool_call",
          callId: "c1",
          name: "Bash",
          input: { command: "pnpm migrate" },
          output: "hidden output",
          status: "done",
        },
        { type: "file_change", path: "src/db/0008_messages_fts.ts", diff: "+hidden diff" },
      ])
      const search = yield* Search.Search

      expect((yield* search.threads("pnpm migrate")).map((hit) => hit.messageId)).toStrictEqual([tool])
      expect((yield* search.threads("messages_fts")).map((hit) => hit.messageId)).toStrictEqual([tool])
      expect(yield* search.threads("hidden")).toStrictEqual([])
      expect(yield* search.threads("secret")).toStrictEqual([])
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("shows a tool call the way the transcript titles it, not its raw input", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: repo })
      const message = yield* insertMessage(threadId, [
        call("c1", "mcp__hinacode__create_thread", { prompt: "Retry failed payments", mode: "worktree" }),
        call("c2", "WebFetch", { url: "https://docs.stripe.com/webhooks", prompt: "How are retries scheduled?" }),
        call("c3", "search_issues", {
          type: "mcpToolCall",
          server: "linear",
          tool: "search_issues",
          arguments: { query: "stripe refunds" },
        }),
      ])
      const search = yield* Search.Search

      const [hit] = yield* search.threads("stripe")
      expect(hit?.snippet).toContain("create_thread WebFetch https://docs.stripe.com/webhooks linear/search_issues")
      expect(hit?.snippet).not.toMatch(/[{}"]/)
      expect((yield* search.threads("linear/search_issues")).map(({ messageId }) => messageId)).toStrictEqual([message])
      expect(yield* search.threads("worktree")).toStrictEqual([])
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("reindexes tool calls that an older index stored as raw input", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { threadId } = yield* seedThread({ rootPath: repo })
      const message = yield* insertMessage(threadId, [
        { type: "tool_call", callId: "c1", name: "Grep", input: { pattern: "stripe", glob: "*.ts" }, status: "done" },
      ])
      yield* sql`UPDATE message_fts SET body = ${`Grep\n{"pattern":"stripe","glob":"*.ts"}`}`
      yield* ftsToolTitles
      const search = yield* Search.Search

      expect((yield* search.threads("stripe")).map((hit) => [hit.messageId, hit.snippet])).toStrictEqual([
        [message, "Grep stripe"],
      ])
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("leaves side chats out of the results", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { threadId } = yield* seedThread({ rootPath: repo })
      yield* sql`INSERT INTO thread (id, project_id, title, provider, model, status, sort_index, created_at, updated_at, side_of)
        SELECT 'side', project_id, title, provider, model, status, sort_index, created_at, updated_at, id
        FROM thread WHERE id = ${threadId}`
      yield* insertMessage("side", [text("only the side chat says pineapple")])
      const search = yield* Search.Search
      expect(yield* search.threads("pineapple")).toStrictEqual([])
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("matches short, CJK and wildcard-looking queries literally", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: repo })
      const cjk = yield* insertMessage(threadId, [text("資料庫遷移完成")])
      const snake = yield* insertMessage(threadId, [text("call snake_case and 100% done")])
      yield* insertMessage(threadId, [text("call snakeXcase and 100 done")])
      const search = yield* Search.Search

      expect((yield* search.threads("遷移")).map((hit) => hit.messageId)).toStrictEqual([cjk])
      expect((yield* search.threads("e_c")).map((hit) => hit.messageId)).toStrictEqual([snake])
      expect((yield* search.threads("100%")).map((hit) => hit.messageId)).toStrictEqual([snake])
      expect(yield* search.threads("  ")).toStrictEqual([])
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("finds one and two character Chinese, Japanese and Korean words only where they are adjacent", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: repo })
      const chinese = yield* insertMessage(threadId, [text("先改資料庫，再跑 migration")])
      const japanese = yield* insertMessage(threadId, [text("検索をテストする")])
      const korean = yield* insertMessage(threadId, [text("검색 완료")])
      const quoted = yield* insertMessage(threadId, [text('run "改a" now')])
      const search = yield* Search.Search
      const found = (query: string) =>
        search.threads(query).pipe(Effect.map((hits) => hits.map((hit) => hit.messageId)))

      expect(yield* found("改")).toStrictEqual([quoted, chinese])
      expect(yield* found("資料")).toStrictEqual([chinese])
      expect(yield* found("改再")).toStrictEqual([])
      expect(yield* found("する")).toStrictEqual([japanese])
      expect(yield* found("ト")).toStrictEqual([japanese])
      expect(yield* found("검색")).toStrictEqual([korean])
      expect(yield* found("改a")).toStrictEqual([quoted])
      expect(yield* found('"改a"')).toStrictEqual([quoted])
      expect((yield* search.perThread("庫", { limit: 3 })).map((hit) => hit.snippet)).toStrictEqual([
        "先改資料庫，再跑 migration",
      ])
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("keeps short CJK matches in step with message updates and deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { threadId } = yield* seedThread({ rootPath: repo })
      const id = yield* insertMessage(threadId, [text("舊的回答")])
      const search = yield* Search.Search
      const found = (query: string) =>
        search.threads(query).pipe(Effect.map((hits) => hits.map((hit) => hit.messageId)))

      expect(yield* found("舊")).toStrictEqual([id])
      yield* sql`UPDATE message SET parts = ${JSON.stringify([text("新的回答")])} WHERE id = ${id}`
      expect(yield* found("舊")).toStrictEqual([])
      expect(yield* found("新的")).toStrictEqual([id])
      expect(yield* sql`SELECT rowid FROM message_cjk WHERE grams MATCH '新'`).toHaveLength(1)

      yield* sql`DELETE FROM thread WHERE id = ${threadId}`
      expect(yield* found("新的")).toStrictEqual([])
      expect(yield* sql`SELECT rowid FROM message_cjk WHERE grams MATCH '新'`).toStrictEqual([])
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("follows message updates and deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { threadId } = yield* seedThread({ rootPath: repo })
      const id = yield* insertMessage(threadId, [text("streaming the first")])
      const search = yield* Search.Search

      yield* sql`
        UPDATE message SET parts = ${JSON.stringify([text("still streaming")])}, completed_at = NULL WHERE id = ${id}
      `
      expect(yield* search.threads("still")).toStrictEqual([])

      yield* sql`
        UPDATE message SET parts = ${JSON.stringify([text("rewritten answer")])}, completed_at = '2026-01-01T00:00:00.000Z' WHERE id = ${id}
      `
      expect(yield* search.threads("streaming")).toStrictEqual([])
      expect((yield* search.threads("rewritten")).map((hit) => hit.messageId)).toStrictEqual([id])

      yield* sql`DELETE FROM thread WHERE id = ${threadId}`
      expect(yield* search.threads("rewritten")).toStrictEqual([])
    }).pipe(withSearch(Search.layer)),
  )
})

describe("Search.files", () => {
  it.effect("finds lines in the thread's workspace with paths relative to it, skipping ignored files", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: repo })
      const search = yield* Search.Search

      const hits = yield* search.files(threadId, "createworktree")
      expect(hits.toSorted((a, b) => a.path.localeCompare(b.path))).toStrictEqual([
        { path: "README.md", line: 1, column: 6, text: "Call createWorktree first." },
        { path: join("src", "Worktrees.ts"), line: 2, column: 12, text: "// 遷移 then createWorktree here" },
      ])
      expect(yield* search.files(threadId, "createWorktree", 1)).toHaveLength(1)
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("fails with NotFoundError for a thread it does not know, before running anything", () =>
    Effect.gen(function* () {
      const search = yield* Search.Search
      const error = yield* search.files("no-such-thread", "createWorktree").pipe(Effect.flip)
      expect(error._tag).toBe("NotFoundError")
    }).pipe(withSearch(Search.layer)),
  )

  it.effect("fails with RipgrepMissingError when rg cannot be found or started", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: repo })
      const missing = yield* Effect.gen(function* () {
        const search = yield* Search.Search
        return yield* search.files(threadId, "createWorktree").pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          Layer.effect(
            Search.Search,
            Search.make(() => undefined),
          ),
        ),
      )
      const notStarting = yield* Effect.gen(function* () {
        const search = yield* Search.Search
        return yield* search.files(threadId, "createWorktree").pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          Layer.effect(
            Search.Search,
            Search.make(() => join(repo, "no-such-rg")),
          ),
        ),
      )
      expect(missing._tag).toBe("RipgrepMissingError")
      expect(notStarting._tag).toBe("RipgrepMissingError")
    }).pipe(Effect.provide(Layer.mergeAll(Db.layer(":memory:"), NodeServices.layer))),
  )
})
