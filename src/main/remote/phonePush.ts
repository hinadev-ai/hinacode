import { Effect, Layer, Option, Queue } from "effect"
import type { AgentEvent } from "../../shared/agent.ts"
import type { PushEvent } from "../../shared/contract.ts"
import { PushBroadcast } from "../services/Events.ts"
import { Secrets } from "../services/Secrets.ts"
import { CREDENTIAL_SECRET, DEFAULT_RELAY_SERVICE_URL } from "./relay.ts"
import { type Fetch, type PushReason, relayService } from "./relayService.ts"

/** Why an event notifies the owner's phone, the same events the desktop notifies about. */
export const pushReasonOf = (event: Pick<AgentEvent, "type">): PushReason | undefined => {
  switch (event.type) {
    case "turn_completed":
      return "completed"
    case "approval_requested":
      return "approval"
    case "question_requested":
      return "question"
    case "secret_requested":
      return "secret"
    case "turn_failed":
      return "failed"
    case "turn_limited":
      return "limited"
    default:
      return undefined
  }
}

export interface PhonePushOptions {
  /** The relay service, `https://relay.hinacode.app` by default. */
  readonly serviceUrl?: string
  readonly fetch?: Fetch
}

/**
 * Asks the relay to notify the owner's phones when a thread needs them. A machine that is not linked pushes
 * nothing. A failed push is dropped, since a notification minutes late is worse than none.
 */
export const layer = ({ serviceUrl = DEFAULT_RELAY_SERVICE_URL, fetch = globalThis.fetch }: PhonePushOptions = {}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const broadcast = yield* PushBroadcast
      const secrets = yield* Secrets
      const service = relayService(fetch, serviceUrl)
      const pending = yield* Queue.unbounded<{ readonly threadId: string; readonly reason: PushReason }>()
      // The runner takes the next queued message right after it publishes `turn_completed`, so the queue is
      // read from the pushes as they arrive, the way the desktop reads its store, not from the database later.
      const queued = new Set<string>()

      yield* broadcast.subscribe((event: typeof PushEvent.Encoded) => {
        if (event.type === "thread.updated") {
          if (event.thread.queue.length > 0) queued.add(event.thread.id)
          else queued.delete(event.thread.id)
        }
        if (event.type === "thread.removed") queued.delete(event.id)
        if (event.type !== "thread.event") return
        const reason = pushReasonOf(event.event)
        if (reason === undefined) return
        // A completed turn with messages queued behind it is not the end of the thread's work.
        if (reason === "completed" && queued.has(event.threadId)) return
        Queue.offerUnsafe(pending, { threadId: event.threadId, reason })
      })

      const send = (push: { readonly threadId: string; readonly reason: PushReason }) =>
        Effect.gen(function* () {
          const credential = yield* secrets.get(CREDENTIAL_SECRET)
          if (Option.isNone(credential)) return
          yield* service.push(credential.value, push)
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("phone push dropped", push, cause)))

      yield* Queue.take(pending).pipe(Effect.flatMap(send), Effect.forever, Effect.forkScoped)
    }),
  )
