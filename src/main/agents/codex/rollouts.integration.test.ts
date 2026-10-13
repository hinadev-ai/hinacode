import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "@effect/vitest"
import { makeRolloutUsage } from "./rollouts.ts"

const root = "01a0c6f7-8e77-75b1-9d6a-f583fa33e0da"
const child = "01a0c6f8-4963-79d3-a97a-5abc24adef4e"
const unrelated = "01a0c6f9-0000-7000-8000-000000000000"

// Trimmed from codex-cli 0.155 rollouts. A sub-agent's session_meta names the root thread as session_id.
const sessionMeta = (id: string, sessionId: string) =>
  JSON.stringify({
    type: "session_meta",
    payload: { session_id: sessionId, id, base_instructions: { text: "You are Codex.\n".repeat(2000) } },
  })
const turnContext = (model: string) => JSON.stringify({ type: "turn_context", payload: { model, cwd: "/repo" } })
const usage = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
})
const tokenCount = (input: number, cached: number, output: number) =>
  JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: usage(input, cached, output) } },
  })
const record = (responseId: string, input: number, cached: number, output: number) =>
  JSON.stringify({
    type: "token_usage_record",
    payload: { response_id: responseId, usage: usage(input, cached, output) },
  })

let home: string
const write = (day: string, time: string, id: string, lines: ReadonlyArray<string>) => {
  const dir = join(home, "sessions", ...day.split("-"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `rollout-${day}T${time}-${id}.jsonl`), lines.map((line) => `${line}\n`).join(""))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kk-codex-home-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe("makeRolloutUsage", () => {
  test("counts the growth of repeated totals and adds sub-agent rollouts found by session id", async () => {
    write("2026-09-22", "11-35-07", root, [
      sessionMeta(root, root),
      turnContext("gpt-6-astra"),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }),
      tokenCount(1000, 600, 50),
      tokenCount(1000, 600, 50),
      tokenCount(2500, 1800, 120),
      turnContext("gpt-6-sol"),
      tokenCount(4000, 3000, 200),
      // The total restarts from zero partway through a rollout.
      tokenCount(300, 100, 10),
    ])
    write("2026-09-22", "11-35-55", child, [
      sessionMeta(child, root),
      turnContext("gpt-6-astra"),
      tokenCount(500, 200, 20),
    ])
    write("2026-09-22", "11-40-00", unrelated, [sessionMeta(unrelated, unrelated), turnContext("gpt-6-astra")])
    write("2026-09-22", "11-41-00", "01a0c6fa-0000-7000-8000-000000000000", [
      sessionMeta("01a0c6fa-0000-7000-8000-000000000000", unrelated),
      turnContext("gpt-6-astra"),
      tokenCount(9999, 0, 9999),
    ])

    expect(await makeRolloutUsage(home)(root)).toStrictEqual({
      models: [
        { model: "gpt-6-astra", inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 2000, outputTokens: 140 },
        { model: "gpt-6-sol", inputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 1300, outputTokens: 90 },
      ],
      transcripts: 2,
    })
  })

  test("prefers per-response records, which also count compaction requests", async () => {
    write("2026-10-12", "15-29-08", root, [
      sessionMeta(root, root),
      turnContext("gpt-6-astra"),
      record("resp_1", 1000, 600, 50),
      tokenCount(1000, 600, 50),
      record("resp_compact", 2000, 0, 300),
      tokenCount(1000, 600, 50),
    ])

    expect(await makeRolloutUsage(home)(root)).toStrictEqual({
      models: [
        { model: "gpt-6-astra", inputTokens: 2400, cacheWriteTokens: 0, cacheReadTokens: 600, outputTokens: 350 },
      ],
      transcripts: 1,
    })
  })

  test("is null for a thread without a rollout", async () => {
    expect(await makeRolloutUsage(home)(root)).toBeNull()
  })
})
