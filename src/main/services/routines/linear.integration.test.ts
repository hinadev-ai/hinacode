import { createHmac } from "node:crypto"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Layer, Schedule, Stream } from "effect"
import type { RoutineTrigger } from "../../../shared/domain.ts"
import { CallingThread } from "../../mcp/tools/tool.ts"
import type { LinearClient } from "@linear/sdk"
import { LinearTools, linearToolsLayer } from "../../mcp/tools/linear.ts"
import { ReplyTools, replyToolsLayer } from "../../mcp/tools/reply.ts"
import {
  DEMO_VIEWER_ID,
  Linear,
  LINEAR_WEBHOOK_SECRET,
  LinearRequestError,
  mockLayer as mockLinear,
} from "../Linear.ts"
import { Secrets } from "../Secrets.ts"
import { Slack } from "../slack/Slack.ts"
import { Routines } from "./Routines.ts"
import { userTexts, withApp } from "./testing.ts"
import { FOLLOW_UP } from "./triggers.ts"

interface Posted {
  readonly issueId: string
  readonly body: string
  readonly id: string
}

const recordingLinear = (posted: Array<Posted>) =>
  Layer.effect(
    Linear,
    Effect.map(Linear, (mock) =>
      Linear.of({
        ...mock,
        comment: (issueId, body) =>
          mock
            .comment(issueId, body)
            .pipe(Effect.tap(({ id }) => Effect.sync(() => void posted.push({ issueId, body, id })))),
      }),
    ),
  ).pipe(Layer.provide(mockLinear))

const countingViewer = (asked: { viewer: number }) =>
  Layer.effect(
    Linear,
    Effect.map(Linear, (mock) =>
      Linear.of({
        ...mock,
        viewerId: Effect.suspend(() => {
          asked.viewer += 1
          return mock.viewerId
        }),
      }),
    ),
  ).pipe(Layer.provide(mockLinear))

const flakyViewer = (viewer: { down: boolean }) =>
  Layer.effect(
    Linear,
    Effect.map(Linear, (mock) =>
      Linear.of({
        ...mock,
        viewerId: Effect.suspend(() =>
          viewer.down ? Effect.fail(new LinearRequestError({ reason: "offline" })) : mock.viewerId,
        ),
      }),
    ),
  ).pipe(Layer.provide(mockLinear))

const onComments: RoutineTrigger = {
  event: "linear.comment",
  fromUsers: ["ada@acme.dev"],
  scopes: ["ENG"],
  contains: null,
  continuation: "conversation",
}

const triggered = (projectId: string, trigger: Partial<RoutineTrigger> = {}) =>
  Routines.use((routines) =>
    routines.create({
      projectId,
      name: "Linear helper",
      enabled: true,
      prompt: "Answer the issue",
      provider: "claude",
      model: "test-model",
      effort: null,
      workspace: "local",
      schedule: null,
      trigger: { ...onComments, ...trigger },
    }),
  )

const issue = {
  id: "issue-1",
  identifier: "ENG-12",
  title: "Login fails on Safari",
  url: "https://linear.app/acme/issue/ENG-12/login-fails-on-safari",
  teamId: "team-eng",
  team: { id: "team-eng", key: "ENG", name: "Engineering" },
}

const ada = { id: "user-ada", type: "user", name: "Ada", email: "ada@acme.dev", url: "https://linear.app/acme/ada" }

const now = Clock.currentTimeMillis

const commentDelivery = (
  id: string,
  {
    body = "Can you look at this?",
    actor = ada,
    onIssue = issue,
    at,
  }: { body?: string; actor?: typeof ada; onIssue?: typeof issue; at?: number } = {},
) =>
  Effect.map(now, (current) =>
    JSON.stringify({
      type: "Comment",
      action: "create",
      actor,
      createdAt: "2026-11-25T10:00:00.000Z",
      organizationId: "org-1",
      webhookId: "hook-1",
      webhookTimestamp: at ?? current,
      data: { id, body, issueId: onIssue.id, issue: onIssue, reactionData: {}, createdAt: "", updatedAt: "" },
    }),
  )

const assignmentDelivery = Effect.map(now, (current) =>
  JSON.stringify({
    type: "Issue",
    action: "create",
    actor: ada,
    createdAt: "2026-11-25T10:00:00.000Z",
    organizationId: "org-1",
    webhookId: "hook-1",
    webhookTimestamp: current,
    data: { ...issue, description: "Safari shows a blank page.", assigneeId: DEMO_VIEWER_ID, updatedAt: "t1" },
  }),
)

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex")

const postLinear = (port: number, body: string, headers: Record<string, string> = {}) =>
  Effect.tryPromise(() =>
    fetch(`http://127.0.0.1:${port}/hooks/linear`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "linear-event": "Comment", ...headers },
    }).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    })),
  ).pipe(Effect.retry({ times: 100 }))

const SECRET = "lin_wh_s3cret"

const deliver = (port: number, body: string) => postLinear(port, body, { "linear-signature": sign(SECRET, body) })

const storeSecret = Secrets.use((secrets) => secrets.set(LINEAR_WEBHOOK_SECRET, SECRET))

const runsUntil = (routineId: string, count: number) =>
  Routines.use((routines) => routines.runs(routineId, 50)).pipe(
    Effect.repeat({
      until: (runs) => runs.length >= count && runs.every((run) => run.status !== "started" || run.threadId !== null),
      schedule: Schedule.spaced("10 millis"),
    }),
    Effect.map((runs) => runs.toReversed()),
  )

const replyFrom = (threadId: string, text: string) =>
  Effect.gen(function* () {
    const toolkit = yield* ReplyTools
    const results = yield* toolkit.handle("reply", { text })
    return yield* Stream.runLast(results)
  }).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.map(({ result }) => result),
    Effect.provide(replyToolsLayer),
    Effect.provide(Layer.mock(Slack, {})),
    Effect.provideService(CallingThread, threadId),
  )

describe("Linear deliveries", () => {
  it.live("starts one thread for a signed comment from an allowed person in an allowed team", () =>
    withApp(({ projectId, port }) =>
      Effect.gen(function* () {
        yield* storeSecret
        const routine = yield* triggered(projectId)
        const hooks = yield* Routines.use((routines) => routines.webhook(routine.id))
        expect(hooks.linearUrl).toBe(`http://127.0.0.1:${port}/hooks/linear`)

        const first = yield* commentDelivery("comment-1")
        const delivered = yield* deliver(port, first)
        expect(delivered.status).toBe(200)
        const [run] = yield* runsUntil(routine.id, 1)
        expect(delivered.body).toStrictEqual({ runs: [{ runId: run!.id, threadId: run!.threadId, status: "started" }] })
        const [prompt] = yield* userTexts(run!.threadId, 1)
        expect(prompt).toMatch(/^Answer the issue\n\n```json\n/)
        expect(prompt).toContain('"event": "linear.comment"')
        expect(prompt).toContain('"from": "ada@acme.dev"')
        expect(prompt).toContain('"text": "Can you look at this?"')
        expect(prompt).toContain(`"url": "${issue.url}"`)

        const again = yield* deliver(port, first)
        expect(again.status).toBe(200)
        expect(again.body["runs"]).toMatchObject([{ status: "skipped" }])

        const stranger = yield* deliver(
          port,
          yield* commentDelivery("comment-2", { actor: { ...ada, email: "eve@x.dev" } }),
        )
        expect(stranger).toStrictEqual({ status: 200, body: { runs: [] } })
        const otherTeam = {
          ...issue,
          id: "issue-2",
          identifier: "OPS-3",
          team: { id: "team-ops", key: "OPS", name: "Ops" },
        }
        const elsewhere = yield* deliver(port, yield* commentDelivery("comment-3", { onIssue: otherTeam }))
        expect(elsewhere).toStrictEqual({ status: 200, body: { runs: [] } })

        expect((yield* runsUntil(routine.id, 2)).map((each) => [each.status, each.threadId])).toStrictEqual([
          ["started", run!.threadId],
          ["skipped", null],
        ])
      }),
    ),
  )

  it.live("hands a later comment on the same issue to the same thread", () =>
    withApp(({ projectId, port }) =>
      Effect.gen(function* () {
        yield* storeSecret
        const routine = yield* triggered(projectId)
        yield* deliver(port, yield* commentDelivery("comment-1"))
        const [first] = yield* runsUntil(routine.id, 1)
        yield* userTexts(first!.threadId, 1)

        const later = yield* deliver(port, yield* commentDelivery("comment-2", { body: "Any news?" }))
        expect(later.status).toBe(200)
        const [, second] = yield* runsUntil(routine.id, 2)
        expect(second!.threadId).toBe(first!.threadId)
        const [, followUp] = yield* userTexts(first!.threadId, 2)
        expect(followUp).toContain(FOLLOW_UP)
        expect(followUp).toContain('"text": "Any news?"')
      }),
    ),
  )

  it.live("does not ask Linear whose key it is for a comment", () => {
    const asked = { viewer: 0 }
    return withApp(
      ({ projectId, port }) =>
        Effect.gen(function* () {
          yield* storeSecret
          const routine = yield* triggered(projectId)
          yield* deliver(port, yield* commentDelivery("comment-1"))
          yield* runsUntil(routine.id, 1)
          expect(asked.viewer).toBe(0)
        }),
      undefined,
      countingViewer(asked),
    )
  })

  it.live("starts a thread when an issue is assigned to the API key's account", () =>
    withApp(
      ({ projectId, port }) =>
        Effect.gen(function* () {
          yield* storeSecret
          const routine = yield* triggered(projectId, { event: "linear.issue_assigned" })
          const delivered = yield* deliver(port, yield* assignmentDelivery)
          expect(delivered.status).toBe(200)
          const [run] = yield* runsUntil(routine.id, 1)
          const [prompt] = yield* userTexts(run!.threadId, 1)
          expect(prompt).toContain('"text": ""')
          expect(prompt).toContain('"description": "Safari shows a blank page."')
        }),
      undefined,
      recordingLinear([]),
    ),
  )

  it.live("asks Linear to deliver an assignment again when it cannot tell whose key it is", () => {
    const viewer = { down: true }
    return withApp(
      ({ projectId, port }) =>
        Effect.gen(function* () {
          yield* storeSecret
          const routine = yield* triggered(projectId, { event: "linear.issue_assigned" })
          const body = yield* assignmentDelivery
          expect((yield* deliver(port, body)).status).toBe(503)
          expect(yield* Routines.use((routines) => routines.runs(routine.id, 10))).toStrictEqual([])

          viewer.down = false
          expect((yield* deliver(port, body)).status).toBe(200)
          expect(yield* runsUntil(routine.id, 1)).toHaveLength(1)
        }),
      undefined,
      flakyViewer(viewer),
    )
  })

  it.live("refuses a delivery without a valid signature or with a stale timestamp", () =>
    withApp(({ projectId, port }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId)
        const body = yield* commentDelivery("comment-1")
        expect((yield* deliver(port, body)).status).toBe(401)

        yield* storeSecret
        expect((yield* postLinear(port, body)).status).toBe(401)
        expect((yield* postLinear(port, body, { "linear-signature": sign("wrong", body) })).status).toBe(401)
        expect((yield* postLinear(port, body, { "linear-signature": `sha256=${sign(SECRET, body)}` })).status).toBe(401)
        const stale = yield* commentDelivery("comment-1", { at: (yield* now) - 61_000 })
        expect((yield* deliver(port, stale)).status).toBe(401)
        const undated = JSON.stringify({ ...JSON.parse(body), webhookTimestamp: undefined })
        expect((yield* deliver(port, undated)).status).toBe(401)
        expect((yield* deliver(port, "not json")).status).toBe(400)
        expect((yield* deliver(port, "x".repeat(1024 * 1024 + 1))).status).toBe(413)

        expect(yield* Routines.use((routines) => routines.runs(routine.id, 10))).toStrictEqual([])
      }),
    ),
  )
})

describe("linear_create_comment", () => {
  it.effect("posts a comment HinaCode recognizes as its own", () => {
    const posted: Array<Posted> = []
    const client = {
      issue: () => Promise.resolve(issue),
    } as unknown as LinearClient
    const linear = Layer.effect(
      Linear,
      Effect.map(Linear, (recording) => Linear.of({ ...recording, client: Effect.succeedSome(client) })),
    ).pipe(Layer.provide(recordingLinear(posted)))
    return Effect.gen(function* () {
      const toolkit = yield* LinearTools
      yield* Stream.runDrain(yield* toolkit.handle("linear_create_comment", { key: issue.identifier, body: "On it" }))
      expect(posted).toMatchObject([{ issueId: issue.id, body: "On it" }])
      expect(yield* Linear.use((service) => service.wroteComment(posted[0]!.id))).toBe(true)
    }).pipe(Effect.provide(linearToolsLayer), Effect.provide(linear), Effect.provideService(CallingThread, "thread-1"))
  })
})

describe("Linear replies", () => {
  it.live("posts the reply on the issue, and the reply coming back starts nothing", () => {
    const posted: Array<Posted> = []
    return withApp(
      ({ projectId, port }) =>
        Effect.gen(function* () {
          yield* storeSecret
          const routine = yield* triggered(projectId)
          yield* deliver(port, yield* commentDelivery("comment-1"))
          const [run] = yield* runsUntil(routine.id, 1)

          expect(yield* replyFrom(run!.threadId!, "Fixed in #13")).toBe(`Posted to ${issue.url}`)
          expect(posted).toMatchObject([{ issueId: issue.id, body: "Fixed in #13" }])

          const echo = yield* deliver(port, yield* commentDelivery(posted[0]!.id, { body: "Fixed in #13" }))
          expect(echo).toStrictEqual({ status: 200, body: { runs: [] } })
          expect(yield* runsUntil(routine.id, 1)).toHaveLength(1)
        }),
      undefined,
      recordingLinear(posted),
    )
  })

  it.live("tells the agent when this machine has no Linear API key", () =>
    withApp(({ projectId, port }) =>
      Effect.gen(function* () {
        yield* storeSecret
        const routine = yield* triggered(projectId)
        yield* deliver(port, yield* commentDelivery("comment-1"))
        const [run] = yield* runsUntil(routine.id, 1)
        expect(yield* Effect.flip(replyFrom(run!.threadId!, "Done"))).toStrictEqual({
          message: "Linear has no API key on this machine.",
        })
      }),
    ),
  )
})
