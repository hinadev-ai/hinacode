import { type Cause, Effect, Queue } from "effect"
import type { PushEvent } from "../shared/contract.ts"
import type { Thread } from "../shared/domain.ts"
import { EXIT, unreachableError } from "./exit.ts"
import type { Output } from "./session.ts"

type Outcome =
  | { readonly outcome: "done" }
  | { readonly outcome: "failed"; readonly message: string }
  | { readonly outcome: "needsHuman" }
  | { readonly outcome: "limited"; readonly message: string }

const OUTCOME_EXIT = { done: EXIT.done, failed: EXIT.failed, needsHuman: EXIT.needsHuman, limited: EXIT.limited }

export const outcomeOf = (push: PushEvent, threadId: string): Outcome | undefined => {
  if (push.type !== "thread.event" || push.threadId !== threadId) return undefined
  const { event } = push
  switch (event.type) {
    case "turn_completed":
      return { outcome: "done" }
    case "turn_failed":
      return { outcome: "failed", message: event.message }
    case "turn_limited":
      return { outcome: "limited", message: event.limit.message }
    case "approval_requested":
    case "question_requested":
    case "secret_requested":
      return { outcome: "needsHuman" }
    default:
      return undefined
  }
}

export const awaitOutcome = (events: Queue.Dequeue<PushEvent, Cause.Done>, thread: Thread) =>
  Effect.gen(function* () {
    while (true) {
      const push = yield* Queue.take(events).pipe(
        Effect.mapError(() => unreachableError("lost the connection to HinaCode")),
      )
      const outcome = outcomeOf(push, thread.id)
      if (outcome === undefined) continue
      return {
        value: { threadId: thread.id, title: thread.title, ...outcome },
        code: OUTCOME_EXIT[outcome.outcome],
      } satisfies Output
    }
  })
