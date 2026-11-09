import { Effect, Queue } from "effect"
import { Command } from "effect/cli"
import { PushEvent } from "../../shared/contract.ts"
import { noticeEvents } from "../../shared/remote.ts"
import { unreachableError } from "../exit.ts"
import { encode, withClient, writeLine } from "../session.ts"

export const watch = Command.make("watch", {}, () =>
  withClient((client) =>
    Effect.gen(function* () {
      const events = yield* client.subscribe
      while (true) {
        const push = yield* Queue.take(events).pipe(
          Effect.mapError(() => unreachableError("lost the connection to HinaCode")),
        )
        if (push.type === "thread.event" && noticeEvents.has(push.event.type))
          yield* writeLine(yield* encode(PushEvent, push))
      }
    }),
  ),
).pipe(
  Command.withDescription(
    "Print one JSON line whenever a thread on any machine finishes, fails, hits a limit or asks for something, until killed.",
  ),
)
