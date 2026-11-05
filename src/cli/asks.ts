import { Schema } from "effect"
import { ApprovalRequest, QuestionRequest, SecretRequest } from "../shared/agent.ts"
import type { RpcResponse } from "../shared/contract.ts"
import { Thread } from "../shared/domain.ts"

export const Ask = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("approval"), threadId: Schema.String, request: ApprovalRequest }),
  Schema.Struct({ kind: Schema.Literal("question"), threadId: Schema.String, request: QuestionRequest }),
  Schema.Struct({ kind: Schema.Literal("secret"), threadId: Schema.String, request: SecretRequest }),
  Schema.Struct({ kind: Schema.Literal("limited"), thread: Thread }),
])
export type Ask = typeof Ask.Type

type Pending = Pick<RpcResponse<"threads.transcript">, "approvals" | "questions" | "secretRequests">

const pendingAsks = (threadId: string, pending: Pending): ReadonlyArray<Ask> => [
  ...pending.approvals.map((request): Ask => ({ kind: "approval", threadId, request })),
  ...pending.questions.map((request): Ask => ({ kind: "question", threadId, request })),
  ...pending.secretRequests.map((request): Ask => ({ kind: "secret", threadId, request })),
]

export const asksFrom = (
  threads: ReadonlyArray<Thread>,
  transcripts: ReadonlyMap<string, Pending>,
): ReadonlyArray<Ask> =>
  threads.flatMap((thread): ReadonlyArray<Ask> => {
    if (thread.status === "limited") return [{ kind: "limited", thread }]
    const pending = transcripts.get(thread.id)
    return thread.status === "awaiting_approval" && pending !== undefined ? pendingAsks(thread.id, pending) : []
  })
