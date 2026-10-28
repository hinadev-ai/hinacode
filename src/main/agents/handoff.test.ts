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
[tool Bash: done] pnpm test
[edited src/login.ts]
Fixed it.

## assistant
[the conversation moved from Claude Code to Codex here]
</conversation_handoff>

Now add a test`)
})

test("counts the older tool calls once they take a quarter of the budget, and keeps what was said", () => {
  const prompt = handoffPrompt({
    from: "claude",
    to: "codex",
    prompt: "go on",
    budget: 50,
    messages: [
      message("m1", "user", [{ type: "text", text: "Fix login" }]),
      message("m2", "assistant", [
        { type: "tool_call", callId: "c1", name: "Bash", input: { command: "x".repeat(150) }, status: "done" },
        { type: "text", text: "Fixed" },
      ]),
      message("m3", "user", [{ type: "text", text: "now tests" }]),
      message("m4", "assistant", [
        { type: "tool_call", callId: "c2", name: "Bash", input: { command: "ls" }, status: "done" },
        { type: "text", text: "Done" },
      ]),
    ],
  })
  expect(prompt).toContain(
    "## user\nFix login\n\n## assistant\n[1 earlier tool calls and edits left out]\nFixed\n\n## user\nnow tests\n\n## assistant\n[tool Bash: done] ls\nDone",
  )
  expect(prompt).not.toContain("left out to fit")
})

test("keeps the opening request, and leaves out the messages after it that do not fit", () => {
  const prompt = handoffPrompt({
    from: "codex",
    to: "codex",
    prompt: "go on",
    budget: 48,
    messages: [
      message("m1", "user", [{ type: "text", text: "the task" }]),
      message("m2", "user", [{ type: "text", text: `dropped ${"x".repeat(200)}` }]),
      message("m3", "user", [{ type: "text", text: "middle" }]),
      message("m4", "assistant", [{ type: "text", text: "newest" }]),
    ],
  })
  expect(prompt).toContain("an earlier Codex session that you cannot resume")
  expect(prompt).toContain(
    "## user\nthe task\n\n[1 messages left out here to fit]\n\n## user\nmiddle\n\n## assistant\nnewest",
  )
})

test("cuts a long opening request at an eighth of the budget, counting Japanese by the byte", () => {
  const prompt = handoffPrompt({
    from: "claude",
    to: "codex",
    prompt: "go on",
    budget: 80,
    messages: [message("m1", "user", [{ type: "text", text: "あ".repeat(20) }])],
  })
  expect(prompt).toContain(`\n## user\n${"あ".repeat(7)}…\n</conversation_handoff>`)
})

test("keeps the end of a newest message larger than the budget", () => {
  const prompt = handoffPrompt({
    from: "claude",
    to: "muse",
    prompt: "go on",
    budget: 3,
    messages: [message("m1", "assistant", [{ type: "text", text: "長い返事の終わり" }])],
  })
  expect(prompt).toContain("\n…終わり\n</conversation_handoff>")
})
