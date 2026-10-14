import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { MessagePart } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
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

const withSearch = (layer: Layer.Layer<Search.Search, never, SqlClient.SqlClient>) =>
  Effect.provide(layer.pipe(Layer.provideMerge(Db.layer(":memory:"))))

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

  it.effect("follows message updates and deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { threadId } = yield* seedThread({ rootPath: repo })
      const id = yield* insertMessage(threadId, [text("streaming the first")])
      const search = yield* Search.Search

      yield* sql`UPDATE message SET parts = ${JSON.stringify([text("rewritten answer")])} WHERE id = ${id}`
      expect(yield* search.threads("streaming")).toStrictEqual([])
      expect((yield* search.threads("rewritten")).map((hit) => hit.messageId)).toStrictEqual([id])

      yield* sql`DELETE FROM thread WHERE id = ${threadId}`
      expect(yield* search.threads("rewritten")).toStrictEqual([])
    }).pipe(withSearch(Search.layer)),
  )
})

describe("Search.files", () => {
  it.effect("resolves ripgrep lazily once per service, including a missing executable", () => {
    let lookups = 0
    return Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: repo })
      const search = yield* Search.Search
      expect(lookups).toBe(0)
      expect(yield* search.files(threadId, "  ")).toStrictEqual([])
      expect(lookups).toBe(0)
      for (const query of ["createWorktree", "README"]) {
        const error = yield* search.files(threadId, query).pipe(Effect.flip)
        expect(error._tag).toBe("RipgrepMissingError")
      }
      expect(lookups).toBe(1)
    }).pipe(
      withSearch(
        Layer.effect(
          Search.Search,
          Search.make(() => {
            lookups++
            return undefined
          }),
        ),
      ),
    )
  })

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
    }).pipe(Effect.provide(Db.layer(":memory:"))),
  )
})
