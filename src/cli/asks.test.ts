import { describe, expect, test } from "@effect/vitest"
import type { ApprovalRequest, QuestionRequest, SecretRequest } from "../shared/agent.ts"
import type { Thread } from "../shared/domain.ts"
import { asksFrom } from "./asks.ts"

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p1",
  worktreeId: null,
  title: `title ${id}`,
  provider: "claude",
  model: "m",
  effort: null,
  fastMode: false,
  accessMode: "auto",
  accountId: null,
  providerSessionId: null,
  forkedFrom: null,
  sideOf: null,
  parentId: null,
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  settledAt: null,
  interruptedAt: null,
  snoozedUntil: null,
  queue: [],
  scheduled: [],
  createdBy: "user",
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  ...patch,
})

const approval = (id: string, threadId: string): ApprovalRequest => ({
  id,
  threadId,
  provider: "claude",
  kind: "command",
  title: "Bash",
  detail: "Run the reset",
  input: { command: "pnpm db:reset\n--force" },
})

const question: QuestionRequest = {
  id: "q1",
  threadId: "t2",
  provider: "codex",
  questions: [
    {
      id: "currency",
      header: "Data",
      question: "Which currency table is canonical?",
      options: [],
      multiSelect: false,
      allowsText: true,
      secret: false,
    },
  ],
}

const secret: SecretRequest = {
  id: "s1",
  threadId: "t1",
  name: "STRIPE_KEY",
  description: "Test mode key\nfrom the dashboard",
}

const limit = { kind: "usage", message: "You've hit your limit", reset: null } as const

describe("asksFrom", () => {
  test("joins waiting threads with their open requests, and lists limited and interrupted threads", () => {
    const waiting = thread("t1", { status: "awaiting_approval" })
    const asking = thread("t2", { status: "awaiting_approval" })
    const limited = thread("t3", { status: "limited", usageLimit: limit })
    const interrupted = thread("t5", { interruptedAt: "2026-11-10T03:00:00.000Z" })
    const transcripts = new Map([
      ["t1", { approvals: [approval("a1", "t1")], questions: [], secretRequests: [secret] }],
      ["t2", { approvals: [], questions: [question], secretRequests: [] }],
      ["t4", { approvals: [approval("stale", "t4")], questions: [], secretRequests: [] }],
    ])
    const asks = asksFrom([waiting, asking, limited, thread("t4"), interrupted], transcripts)
    expect(asks).toStrictEqual([
      { kind: "approval", threadId: "t1", request: approval("a1", "t1") },
      { kind: "secret", threadId: "t1", request: secret },
      { kind: "question", threadId: "t2", request: question },
      { kind: "limited", thread: limited },
      { kind: "interrupted", thread: interrupted },
    ])
  })
})
