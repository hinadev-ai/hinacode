import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "@effect/vitest"
import { listClaudeSessions, readClaudeSession } from "./sessions.ts"

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "session.jsonl"), "utf8")
const fixtureId = "87d0f8e9-8061-47d3-a18a-736d868a56a4"
const cwd = "/work/fruit-shop"

let home: string
const write = (sessionId: string, text: string, projectKey = "-work-fruit-shop") => {
  mkdirSync(join(home, "projects", projectKey), { recursive: true })
  writeFileSync(join(home, "projects", projectKey, `${sessionId}.jsonl`), text)
}

let clock = Date.parse("2026-10-01T00:00:00.000Z")
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const entry = (n: number, parent: number | null, fields: Record<string, unknown>) =>
  JSON.stringify({
    uuid: uuid(n),
    parentUuid: parent === null ? null : uuid(parent),
    isSidechain: false,
    sessionId: "s",
    cwd,
    timestamp: new Date((clock += 1000)).toISOString(),
    ...fields,
  })
const prompt = (n: number, parent: number | null, content: unknown, fields: Record<string, unknown> = {}) =>
  entry(n, parent, { type: "user", message: { role: "user", content }, ...fields })
const reply = (n: number, parent: number, text: string) =>
  entry(n, parent, {
    type: "assistant",
    message: { id: `msg_${n}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text }] },
  })
const transcript = (...lines: ReadonlyArray<string>) => `${lines.join("\n")}\n`
const sessionId = "11111111-1111-4111-8111-111111111111"

const said = async (id = sessionId) =>
  ((await readClaudeSession(home, cwd, id)).messages ?? []).map((message) => [
    message.role,
    message.parts.map((part) => (part.type === "text" ? part.text : part.type)).join(" | "),
  ])

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kk-claude-sessions-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe("listClaudeSessions", () => {
  test("lists the folder's sessions with their title, first prompt and branch", async () => {
    write(fixtureId, fixture)
    expect(await listClaudeSessions(home, cwd)).toStrictEqual([
      {
        sessionId: fixtureId,
        title: "Stock.txt fruit list",
        preview:
          "Create a file stock.txt listing three fruits, one per line: mango, kiwi, lychee. Then reply with just: done",
        branch: "main",
        updatedAt: expect.any(String),
      },
    ])
  })

  test("leaves out a folder whose path encodes to the same project key", async () => {
    write(fixtureId, fixture)
    expect(await listClaudeSessions(home, "/work-fruit-shop")).toStrictEqual([])
    expect(await listClaudeSessions(home, "/work/other")).toStrictEqual([])
  })
})

describe("readClaudeSession", () => {
  test("rebuilds the recorded turns with their tool calls, edits and fork points", async () => {
    write(fixtureId, fixture)
    const history = await readClaudeSession(home, cwd, fixtureId)
    expect(history.title).toBe("Stock.txt fruit list")
    expect(history.model).toBe("claude-haiku-5-5")
    const messages = history.messages ?? []
    expect(messages.map((message) => message.role)).toStrictEqual(["user", "assistant", "user", "assistant"])
    expect(messages[1]?.parts).toMatchObject([
      { type: "tool_call", name: "Write", status: "done", input: { file_path: `${cwd}/stock.txt` } },
      { type: "file_change", path: `${cwd}/stock.txt` },
      { type: "text", text: "done" },
    ])
    expect(messages[3]?.parts).toMatchObject([
      { type: "tool_call", name: "Bash", status: "done", output: "mango\nkiwi\nlychee" },
      { type: "text", text: "The second fruit is **kiwi**." },
    ])
    expect(messages[3]?.forkPoint).toStrictEqual({ sessionId: fixtureId, checkpoint: expect.any(String) })
    expect(messages[0]?.forkPoint).toBeNull()
  })

  test("follows the branch the conversation was rewound to", async () => {
    write(
      sessionId,
      transcript(
        prompt(1, null, "first"),
        reply(2, 1, "one"),
        prompt(3, 2, "abandoned"),
        reply(4, 3, "dropped"),
        prompt(5, 2, "rewritten"),
        reply(6, 5, "kept"),
      ),
    )
    expect(await said()).toStrictEqual([
      ["user", "first"],
      ["assistant", "one"],
      ["user", "rewritten"],
      ["assistant", "kept"],
    ])
  })

  test("keeps the history before a compaction and drops its summary", async () => {
    write(
      sessionId,
      transcript(
        prompt(1, null, "first"),
        reply(2, 1, "one"),
        entry(3, null, {
          type: "system",
          subtype: "compact_boundary",
          logicalParentUuid: uuid(2),
          compactMetadata: { trigger: "auto", preTokens: 150_000 },
        }),
        prompt(4, 3, "This session is being continued from a previous conversation…", { isCompactSummary: true }),
        prompt(5, 4, "second"),
        reply(6, 5, "two"),
      ),
    )
    expect(await said()).toStrictEqual([
      ["user", "first"],
      ["assistant", "one | compaction"],
      ["user", "second"],
      ["assistant", "two"],
    ])
  })

  test("shows a slash command as typed and skips what never reached the model", async () => {
    write(
      sessionId,
      transcript(
        prompt(
          1,
          null,
          "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the diff</command-args>",
        ),
        reply(2, 1, "Reviewing"),
        prompt(3, 2, "<local-command-stdout>Set model to opus</local-command-stdout>"),
        prompt(4, 3, "[Request interrupted by user]"),
        prompt(5, 4, "Caveat: injected", { isMeta: true }),
        prompt(6, 5, "<task-notification>\n<task-id>b1</task-id>\n</task-notification>"),
        reply(7, 6, "The build finished"),
      ),
    )
    expect(await said()).toStrictEqual([
      ["user", "/review the diff"],
      ["assistant", "Reviewing"],
      ["assistant", "The build finished"],
    ])
  })

  test("replays a long session in full", async () => {
    const lines = Array.from({ length: 600 }, (_, turn) => [
      prompt(turn * 2 + 1, turn === 0 ? null : turn * 2, `prompt ${turn}`),
      reply(turn * 2 + 2, turn * 2 + 1, `reply ${turn}`),
    ]).flat()
    write(sessionId, transcript(...lines))
    const messages = await said()
    expect(messages).toHaveLength(1200)
    expect(messages[0]).toStrictEqual(["user", "prompt 0"])
    expect(messages.at(-1)).toStrictEqual(["assistant", "reply 599"])
  })

  test("reports no history when the branch points at a record that is missing", async () => {
    write(
      sessionId,
      transcript(prompt(1, null, "first"), reply(2, 1, "one"), prompt(3, 99, "second"), reply(4, 3, "two")),
    )
    expect((await readClaudeSession(home, cwd, sessionId)).messages).toBeNull()
  })

  test("reports no history when the branch loops back on itself", async () => {
    write(sessionId, transcript(prompt(1, 2, "first"), reply(2, 1, "one")))
    expect((await readClaudeSession(home, cwd, sessionId)).messages).toBeNull()
  })

  test("fails for a session that is gone or ran in another folder", async () => {
    await expect(readClaudeSession(home, cwd, sessionId)).rejects.toThrow("no longer")
    write(fixtureId, fixture)
    await expect(readClaudeSession(home, "/work/other", fixtureId)).rejects.toThrow("no longer")
  })

  test("reports no history for a transcript with no conversation in it", async () => {
    write(sessionId, transcript(JSON.stringify({ type: "ai-title", aiTitle: "Empty", sessionId, cwd })))
    expect((await readClaudeSession(home, cwd, sessionId)).messages).toBeNull()
  })
})
