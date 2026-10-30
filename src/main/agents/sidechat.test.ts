import { expect, test } from "@effect/vitest"
import type { ForkPoint } from "../../shared/agent.ts"
import type { Message, MessagePart } from "../../shared/domain.ts"
import { latestForkPoint, sidechatPrompt, unseenSince } from "./sidechat.ts"

const message = (
  id: string,
  role: Message["role"],
  parts: ReadonlyArray<MessagePart>,
  forkPoint: ForkPoint | null = null,
): Message => ({
  id,
  threadId: "parent",
  role,
  parts,
  createdAt: "2026-10-30T00:00:00.000Z",
  completedAt: forkPoint === null ? null : "2026-10-30T00:00:00.000Z",
  usage: null,
  forkPoint,
})

const claudeTurn = { sessionId: "s1", checkpoint: "u1", owner: { provider: "claude", accountId: null } } as const
const codexTurn = { sessionId: "s2", checkpoint: "turn-2", owner: { provider: "codex", accountId: "acc" } } as const

const history = [
  message("m1", "user", [{ type: "text", text: "Fix the login bug" }]),
  message("m2", "assistant", [{ type: "text", text: "Fixed it." }], claudeTurn),
  message("m3", "user", [{ type: "text", text: "Now add a test" }]),
  message("m4", "assistant", [
    { type: "tool_call", callId: "c1", name: "Bash", input: { command: "pnpm test" }, status: "running" },
  ]),
]

test("forks from the newest turn the thread's own agent completed", () => {
  expect(latestForkPoint("claude", history)).toEqual(claudeTurn)
  expect(latestForkPoint("codex", history)).toBeNull()
  expect(latestForkPoint("codex", [...history, message("m5", "assistant", [], codexTurn)])).toEqual(codexTurn)
})

test("counts only the messages after the fork point as unseen", () => {
  expect(unseenSince(history, { sessionId: "s1", checkpoint: "u1" }).map((seen) => seen.id)).toEqual(["m3", "m4"])
  expect(unseenSince(history, null)).toBe(history)
})

test("puts the running turn ahead of the side question", () => {
  expect(sidechatPrompt({ unseen: history.slice(2), prompt: "Why pnpm?" })).toBe(`<side_chat>
This is a side chat. The developer asks you something while the main agent keeps working on this conversation in the same workspace. Answer it, and do not edit files or run commands that change anything.
The main conversation went on after your history ends. Here is the rest, oldest first. Tool output is left out, and the last message may still be in progress.

## user
Now add a test

## assistant
[tool Bash: running] pnpm test
</side_chat>

Why pnpm?`)
})

test("asks the side question alone when the fork saw everything", () => {
  expect(sidechatPrompt({ unseen: [], prompt: "Why?" })).toBe(`<side_chat>
This is a side chat. The developer asks you something while the main agent keeps working on this conversation in the same workspace. Answer it, and do not edit files or run commands that change anything.
</side_chat>

Why?`)
})
