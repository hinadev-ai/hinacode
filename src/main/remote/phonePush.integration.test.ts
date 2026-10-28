import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Logger, Queue } from "effect"
import { SqlClient } from "effect/sql"
import type { AgentEvent } from "../../shared/agent.ts"
import type { QueuedMessage } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as AgentAccounts from "../services/AgentAccounts.ts"
import { Events, makeEventsLayer } from "../services/Events.ts"
import * as Git from "../services/Git.ts"
import * as GitHub from "../services/GitHub.ts"
import * as Projects from "../services/Projects.ts"
import * as SecretsModule from "../services/Secrets.ts"
import { Secrets } from "../services/Secrets.ts"
import * as Settings from "../services/Settings.ts"
import * as Terminals from "../services/Terminals.ts"
import * as ThreadsModule from "../services/Threads.ts"
import { Threads } from "../services/Threads.ts"
import * as Worktrees from "../services/Worktrees.ts"
import * as PhonePush from "./phonePush.ts"
import { CREDENTIAL_SECRET } from "./relay.ts"
import type { Fetch } from "./relayService.ts"

const SERVICE_URL = "https://relay.test"

const root = realpathSync(mkdtempSync(join(tmpdir(), "hinacode-phone-push-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

interface Push {
  readonly call: string
  readonly credential: string | null
  readonly body: unknown
}

/**
 * The relay service's push endpoint, answering pushes with `statuses` in order and 204 after them. It also
 * records what the machine logs and each time it looks up its credential.
 */
const fakeRelay = (statuses: Array<number> = []) =>
  Effect.gen(function* () {
    const pushes = yield* Queue.unbounded<Push>()
    const credentialReads = yield* Queue.unbounded<void>()
    const logs: Array<string> = []
    const fetch: Fetch = async (url, init) => {
      Queue.offerUnsafe(pushes, {
        call: `${init.method} ${url.pathname}`,
        credential: new Headers(init.headers).get("Authorization")?.replace("Bearer ", "") ?? null,
        body: JSON.parse(String(init.body)),
      })
      const status = statuses.shift() ?? 204
      return status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify({ error: "boom" }), { status })
    }
    return {
      fetch,
      logs,
      credentialReads,
      next: Queue.take(pushes),
      pending: Queue.size(pushes),
      credentialRead: Queue.take(credentialReads),
    }
  })

type FakeRelay = Effect.Success<ReturnType<typeof fakeRelay>>

/** The real secrets, telling the relay each time the machine looks up its credential. */
const observedSecrets = (reads: Queue.Queue<void>) =>
  Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const secrets = yield* Secrets
      return Secrets.of({
        ...secrets,
        get: (name) =>
          secrets
            .get(name)
            .pipe(Effect.tap(() => (name === CREDENTIAL_SECRET ? Queue.offer(reads, undefined) : Effect.void))),
      })
    }),
  ).pipe(Layer.provide(SecretsModule.layer))

const domain = ThreadsModule.layer.pipe(
  Layer.provideMerge(Terminals.layer),
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(Projects.layer),
  Layer.provide(AgentAccounts.layer),
  Layer.provideMerge(Settings.layer),
  Layer.provide(Layer.mergeAll(Git.layer, GitHub.layer)),
)

const withPhonePush = <A, E>(
  relay: FakeRelay,
  effect: Effect.Effect<A, E, Events | Secrets | Threads | SqlClient.SqlClient>,
) =>
  effect.pipe(
    Effect.provide(
      PhonePush.layer({ serviceUrl: SERVICE_URL, fetch: relay.fetch }).pipe(
        Layer.provideMerge(domain),
        Layer.provideMerge(observedSecrets(relay.credentialReads)),
        Layer.provideMerge(makeEventsLayer(() => {})),
        Layer.provide(
          Logger.layer([
            Logger.make(({ logLevel, message }) => void relay.logs.push(`${logLevel} ${String(message)}`)),
          ]),
        ),
        Layer.provideMerge(Db.layer(":memory:")),
        Layer.provide(Layer.mergeAll(NodeServices.layer, SecretsModule.noKeyring)),
      ),
    ),
  )

const linked = Secrets.use((secrets) => secrets.set(CREDENTIAL_SECRET, "credential-1"))

/** A thread in a project of its own, since a project's root path is unique. */
const newThread = Effect.suspend(() =>
  Effect.map(seedThread({ rootPath: mkdtempSync(join(root, "project-")) }), ({ threadId }) => threadId),
)

let seq = 0
const publish = (threadId: string, event: AgentEvent) =>
  Events.use((events) => events.publish({ type: "thread.event", seq: ++seq, threadId, event }))

/** Changes the thread's queue and announces it, the way the runner does. */
const setQueue = (threadId: string, queue: ReadonlyArray<QueuedMessage>) =>
  Effect.gen(function* () {
    const thread = yield* Threads.use((threads) => threads.update({ id: threadId, queue }))
    yield* Events.use((events) => events.publish({ type: "thread.updated", thread }))
  })

const approval = (threadId: string): AgentEvent => ({
  type: "approval_requested",
  request: { id: "approval-1", threadId, provider: "claude", kind: "command", title: "Run ls", detail: "ls" },
})

describe("phone push", () => {
  it.live("a linked machine pushes each alert with its credential", () =>
    Effect.gen(function* () {
      const relay = yield* fakeRelay()
      yield* withPhonePush(
        relay,
        Effect.gen(function* () {
          yield* linked
          const threadId = yield* newThread
          yield* publish(threadId, approval(threadId))
          yield* publish(threadId, { type: "turn_failed", message: "Crashed" })
          yield* publish(threadId, {
            type: "turn_limited",
            limit: { kind: "usage", message: "Limit reached", reset: null },
          })
          expect(yield* relay.next).toStrictEqual({
            call: "POST /v1/host/push",
            credential: "credential-1",
            body: { threadId, reason: "approval" },
          })
          expect((yield* relay.next).body).toStrictEqual({ threadId, reason: "failed" })
          expect((yield* relay.next).body).toStrictEqual({ threadId, reason: "limited" })
        }),
      )
    }),
  )

  it.live("a completed turn pushes only when nothing was queued behind it as it completed", () =>
    Effect.gen(function* () {
      const relay = yield* fakeRelay()
      yield* withPhonePush(
        relay,
        Effect.gen(function* () {
          yield* linked
          const queued = yield* newThread
          yield* setQueue(queued, [{ id: "q-1", text: "next", attachments: [] }])
          const idle = yield* newThread
          yield* publish(queued, { type: "turn_completed" })
          // The runner takes the queued message for the next turn right after the turn completes.
          yield* setQueue(queued, [])
          yield* publish(idle, { type: "turn_completed" })
          expect((yield* relay.next).body).toStrictEqual({ threadId: idle, reason: "completed" })
          expect(yield* relay.pending).toBe(0)
        }),
      )
    }),
  )

  it.live("an event that alerts nobody pushes nothing", () =>
    Effect.gen(function* () {
      const relay = yield* fakeRelay()
      yield* withPhonePush(
        relay,
        Effect.gen(function* () {
          yield* linked
          const threadId = yield* newThread
          yield* publish(threadId, { type: "text_delta", text: "hello" })
          yield* publish(threadId, approval(threadId))
          expect((yield* relay.next).body).toStrictEqual({ threadId, reason: "approval" })
          expect(yield* relay.pending).toBe(0)
        }),
      )
    }),
  )

  it.live("a machine that is not linked pushes nothing", () =>
    Effect.gen(function* () {
      const relay = yield* fakeRelay()
      yield* withPhonePush(
        relay,
        Effect.gen(function* () {
          const before = yield* newThread
          yield* publish(before, approval(before))
          yield* relay.credentialRead
          const after = yield* newThread
          yield* linked
          yield* publish(after, approval(after))
          expect((yield* relay.next).body).toStrictEqual({ threadId: after, reason: "approval" })
          expect(yield* relay.pending).toBe(0)
        }),
      )
    }),
  )

  it.live("a push the relay refuses is logged and dropped, and the next one still goes out", () =>
    Effect.gen(function* () {
      const relay = yield* fakeRelay([500])
      yield* withPhonePush(
        relay,
        Effect.gen(function* () {
          yield* linked
          const threadId = yield* newThread
          yield* publish(threadId, { type: "turn_failed", message: "Crashed" })
          yield* publish(threadId, approval(threadId))
          expect((yield* relay.next).body).toStrictEqual({ threadId, reason: "failed" })
          expect((yield* relay.next).body).toStrictEqual({ threadId, reason: "approval" })
          expect(yield* relay.pending).toBe(0)
          expect(relay.logs.filter((line) => line.startsWith("Warn"))).toHaveLength(1)
        }),
      )
    }),
  )
})
