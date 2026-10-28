import { expect, test } from "@effect/vitest"
import type { Message, MessagePart } from "../../shared/domain.ts"
import { handoffPrompt } from "./handoff.ts"

const message = (id: string, role: Message["role"], parts: ReadonlyArray<MessagePart>): Message => ({
  id,
  threadId: "t1",
  role,
  parts,
  createdAt: "2026-10-28T00:00:00.000Z",
  completedAt: "2026-10-28T00:00:00.000Z",
  usage: null,
})

test("hands Claude's transcript to Codex ahead of the prompt", () => {
  const prompt = handoffPrompt({
    from: "claude",
    to: "codex",
    prompt: "Now add a test",
    messages: [
      message("m1", "user", [
        { type: "text", text: "Fix the login bug" },
        {
          type: "attachment",
          attachment: { id: "a1", name: "shot.png", path: "/att/shot.png", mime: "image/png", kind: "image", bytes: 1 },
        },
      ]),
      message("m2", "assistant", [
        { type: "reasoning", text: "private thoughts" },
        {
          type: "tool_call",
          callId: "c1",
          name: "Bash",
          input: { command: "pnpm test" },
          output: "ok",
          status: "done",
        },
        { type: "tool_call", callId: "c2", name: "Read", input: {}, status: "done", parentCallId: "c0" },
        { type: "file_change", path: "src/login.ts", diff: "-a\n+b" },
        { type: "text", text: "Fixed it." },
      ]),
      message("m3", "assistant", [{ type: "agent_switch", from: "claude", to: "codex" }]),
    ],
  })
  expect(prompt).toBe(`<conversation_handoff>
This conversation started with Claude Code and continues with you. Tool names below are Claude Code's and may differ from yours. Here is the transcript so far, oldest first. It is context, not a new request. Tool output is left out, so read files again before you rely on them.

## user
Fix the login bug
[attachment shot.png at /att/shot.png]

## assistant
[tool Bash: done] {"command":"pnpm test"}
[edited src/login.ts]
Fixed it.

## assistant
[the conversation moved from Claude Code to Codex here]
</conversation_handoff>

Now add a test`)
})

test("keeps the newest messages within the budget and counts the rest", () => {
  const prompt = handoffPrompt({
    from: "codex",
    to: "codex",
    prompt: "go on",
    budget: 40,
    messages: [
      message("m1", "user", [{ type: "text", text: "the oldest request" }]),
      message("m2", "user", [{ type: "text", text: "middle" }]),
      message("m3", "assistant", [{ type: "text", text: "newest" }]),
    ],
  })
  expect(prompt).toContain("an earlier Codex session that you cannot resume")
  expect(prompt).toContain("1 older messages were left out to fit.")
  expect(prompt).not.toContain("the oldest request")
  expect(prompt).toContain("## user\nmiddle\n\n## assistant\nnewest")
})

test("keeps the end of a newest message larger than the budget", () => {
  const prompt = handoffPrompt({
    from: "claude",
    to: "muse",
    prompt: "go on",
    budget: 10,
    messages: [message("m1", "assistant", [{ type: "text", text: "start of a long reply, the end" }])],
  })
  expect(prompt).toContain("\n…y, the end\n")
  expect(prompt).not.toContain("left out to fit")
})
