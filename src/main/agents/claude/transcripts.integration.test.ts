import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "@effect/vitest"
import { copyTranscripts, makeTranscriptUsage } from "./transcripts.ts"

const sessionId = "31ee17f8-6200-4a50-80ff-96241b83319e"

// Trimmed from Claude Code 2.x transcripts: every content block of a message gets its own line.
const assistant = (
  messageId: string,
  model: string,
  usage: { input: number; cacheWrite: number; cacheRead: number; output: number },
) =>
  JSON.stringify({
    type: "assistant",
    sessionId,
    requestId: `req_${messageId}`,
    message: {
      id: `msg_${messageId}`,
      model,
      role: "assistant",
      content: [{ type: "text", text: "..." }],
      usage: {
        input_tokens: usage.input,
        cache_creation_input_tokens: usage.cacheWrite,
        cache_read_input_tokens: usage.cacheRead,
        cache_creation: { ephemeral_5m_input_tokens: usage.cacheWrite, ephemeral_1h_input_tokens: 0 },
        output_tokens: usage.output,
        service_tier: "standard",
      },
    },
  })
const user = JSON.stringify({ type: "user", message: { role: "user", content: "Count the files" } })

let home: string
const write = (path: string, lines: ReadonlyArray<string>, into = home) => {
  const file = join(into, "projects", "-repo", path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, lines.map((line) => `${line}\n`).join(""))
  return file
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kk-claude-home-"))
  mkdirSync(join(home, "projects", "-other"), { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe("makeTranscriptUsage", () => {
  test("sums the session, its sub-agents and workflow agents, counting each message once", async () => {
    write(`${sessionId}.jsonl`, [
      user,
      assistant("a", "claude-opus-5-5", { input: 2, cacheWrite: 1000, cacheRead: 0, output: 8 }),
      assistant("a", "claude-opus-5-5", { input: 2, cacheWrite: 1000, cacheRead: 0, output: 120 }),
      assistant("b", "claude-opus-5-5", { input: 3, cacheWrite: 50, cacheRead: 1000, output: 40 }),
      assistant("limit", "<synthetic>", { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }),
      "{not json",
    ])
    write(`${sessionId}/subagents/agent-a1.jsonl`, [
      assistant("c", "claude-haiku-5", { input: 10, cacheWrite: 500, cacheRead: 0, output: 30 }),
    ])
    write(`${sessionId}/subagents/workflows/run1/agent-x.jsonl`, [
      assistant("d", "claude-opus-5-5", { input: 1, cacheWrite: 0, cacheRead: 2000, output: 60 }),
      assistant("d", "claude-opus-5-5", { input: 1, cacheWrite: 0, cacheRead: 2000, output: 60 }),
    ])

    expect(await makeTranscriptUsage(home)(sessionId)).toStrictEqual({
      models: [
        { model: "claude-opus-5-5", inputTokens: 6, cacheWriteTokens: 1050, cacheReadTokens: 3000, outputTokens: 220 },
        { model: "claude-haiku-5", inputTokens: 10, cacheWriteTokens: 500, cacheReadTokens: 0, outputTokens: 30 },
      ],
      transcripts: 3,
    })
  })

  test("picks up lines written after the last read", async () => {
    const main = write(`${sessionId}.jsonl`, [
      assistant("a", "claude-opus-5-5", { input: 1, cacheWrite: 0, cacheRead: 0, output: 10 }),
    ])
    const usage = makeTranscriptUsage(home)
    expect((await usage(sessionId))?.models[0]?.outputTokens).toBe(10)

    appendFileSync(main, `${assistant("b", "claude-opus-5-5", { input: 1, cacheWrite: 0, cacheRead: 0, output: 5 })}\n`)
    write(`${sessionId}/subagents/agent-late.jsonl`, [
      assistant("c", "claude-opus-5-5", { input: 1, cacheWrite: 0, cacheRead: 0, output: 7 }),
    ])
    const after = await usage(sessionId)
    expect(after?.models[0]?.outputTokens).toBe(22)
    expect(after?.transcripts).toBe(2)
  })

  test("is null for a session without a transcript", async () => {
    expect(await makeTranscriptUsage(home)(sessionId)).toBeNull()
  })
})

describe("copyTranscripts", () => {
  let other: string
  beforeEach(() => {
    other = mkdtempSync(join(tmpdir(), "kk-claude-home-"))
  })
  afterEach(() => rmSync(other, { recursive: true, force: true }))

  test("copies the session and its agent transcripts, overwriting an older copy", async () => {
    const main = write(`${sessionId}.jsonl`, [
      user,
      assistant("a", "claude-opus-5-5", { input: 2, cacheWrite: 1000, cacheRead: 0, output: 120 }),
    ])
    write(`${sessionId}/subagents/workflows/run1/agent-x.jsonl`, [
      assistant("b", "claude-haiku-5", { input: 10, cacheWrite: 500, cacheRead: 0, output: 30 }),
    ])

    expect(await copyTranscripts(sessionId, home, other)).toBe(true)
    expect(await makeTranscriptUsage(other)(sessionId)).toStrictEqual(await makeTranscriptUsage(home)(sessionId))

    appendFileSync(main, `${assistant("c", "claude-opus-5-5", { input: 1, cacheWrite: 0, cacheRead: 0, output: 5 })}\n`)
    expect(await copyTranscripts(sessionId, home, other)).toBe(true)
    const copied = await makeTranscriptUsage(other)(sessionId)
    expect(copied).toStrictEqual(await makeTranscriptUsage(home)(sessionId))
    expect(copied?.models[0]?.outputTokens).toBe(125)
  })

  test("is false for a session without a transcript", async () => {
    write(`${sessionId}.jsonl`, [user], other)
    expect(await copyTranscripts(sessionId, home, other)).toBe(false)
  })
})
