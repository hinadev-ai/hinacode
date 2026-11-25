import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Queue, Schedule } from "effect"
import type { RoutineTrigger, SlackStatus } from "../../../shared/domain.ts"
import { Routines } from "../routines/Routines.ts"
import { finished, type Harness, makeLayer, provider, seedProject, unusedPort, userTexts } from "../routines/testing.ts"
import { FOLLOW_UP } from "../routines/triggers.ts"
import { Secrets } from "../Secrets.ts"
import { type FakeMessage, type FakeSlack, type FakeWorkspace, makeFakeSlack } from "./fakeSlack.ts"
import { APP_TOKEN_SECRET, BOT_TOKEN_SECRET, layer as slackLayer, Slack } from "./Slack.ts"

const workspace: FakeWorkspace = {
  appToken: "xapp-1-app",
  botToken: "xoxb-bot",
  team: { id: "T1", name: "Acme", url: "https://acme.slack.com/" },
  bot: "hinacode",
}
const tokens = { appToken: workspace.appToken, botToken: workspace.botToken }

const onMentions: RoutineTrigger = {
  event: "slack.mention",
  fromUsers: ["U1"],
  scopes: ["C1"],
  contains: null,
  continuation: "conversation",
}

const status = Slack.use((slack) => slack.status)

const statusUntil = (type: SlackStatus["type"]) =>
  status.pipe(Effect.repeat({ until: (current) => current.type === type, schedule: Schedule.spaced("10 millis") }))

type Base = Layer.Success<ReturnType<typeof makeLayer>>

const stage = <A, E>(
  run: (context: { readonly fake: FakeSlack; readonly projectId: string }) => Effect.Effect<A, E, Slack | Base>,
  before: Effect.Effect<void, unknown, Secrets> = Effect.void,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeSlack(workspace)
    const harness: Harness = { pushes: [], jobs: new Map() }
    const base = yield* Layer.build(makeLayer(harness, yield* unusedPort, provider("claude")))
    yield* Effect.provide(before, base)
    const slack = yield* Effect.provide(Layer.build(slackLayer({ apiUrl: fake.apiUrl })), base)
    const context = Context.merge(base, slack)
    const projectId = yield* Effect.provide(seedProject, context)
    return yield* Effect.provide(run({ fake, projectId }), context)
  }).pipe(Effect.scoped)

const connected = Effect.gen(function* () {
  yield* Slack.use((slack) => slack.connect(tokens))
  return yield* statusUntil("connected")
})

const triggered = (projectId: string) =>
  Routines.use((routines) =>
    routines.create({
      projectId,
      name: "Slack helper",
      enabled: true,
      prompt: "Answer the question",
      provider: "claude",
      model: "test-model",
      effort: null,
      workspace: "local",
      schedule: null,
      trigger: onMentions,
    }),
  )

const runsUntil = (routineId: string, count: number) =>
  Routines.use((routines) => routines.runs(routineId, 50)).pipe(
    Effect.repeat({
      until: (runs) => runs.length >= count && runs.every((run) => run.status !== "started" || run.threadId !== null),
      schedule: Schedule.spaced("10 millis"),
    }),
    Effect.map((runs) => runs.toReversed()),
  )

const question: FakeMessage = { channel: "C1", ts: "1700000000.000100", user: "U1", text: "<@UBOT> why is CI red?" }

interface Quoted {
  readonly event: string
  readonly from: string
  readonly text: string
  readonly url: string
  readonly context: { readonly thread: ReadonlyArray<{ readonly from: string; readonly text: string }> }
}

const quotedIn = (prompt: string | undefined) => {
  const block = /```json\n([\s\S]*)\n```$/.exec(prompt ?? "")
  if (block === null) throw new Error(`no quoted block in ${prompt}`)
  return JSON.parse(block[1]!) as Quoted
}

describe("slack", () => {
  it.live("connects at startup with the stored tokens", () =>
    stage(
      () =>
        Effect.gen(function* () {
          expect(yield* statusUntil("connected")).toStrictEqual({
            type: "connected",
            team: "Acme",
            botUser: "hinacode",
          })
        }),
      Effect.gen(function* () {
        const secrets = yield* Secrets
        yield* secrets.set(APP_TOKEN_SECRET, tokens.appToken)
        yield* secrets.set(BOT_TOKEN_SECRET, tokens.botToken)
      }),
    ),
  )

  it.live("ends in failed when Slack refuses the bot token", () =>
    stage(() =>
      Effect.gen(function* () {
        yield* Slack.use((slack) => slack.connect({ ...tokens, botToken: "xoxb-wrong" }))
        expect(yield* statusUntil("failed")).toStrictEqual({ type: "failed", reason: "invalid_auth" })
      }),
    ),
  )

  it.live("disconnect forgets both tokens and closes the socket", () =>
    stage(({ fake }) =>
      Effect.gen(function* () {
        yield* connected
        const socket = yield* Queue.take(fake.links)
        expect(yield* Slack.use((slack) => slack.disconnect)).toStrictEqual({ type: "disconnected" })
        const secrets = yield* Secrets
        expect(Option.isNone(yield* secrets.get(APP_TOKEN_SECRET))).toBe(true)
        expect(Option.isNone(yield* secrets.get(BOT_TOKEN_SECRET))).toBe(true)
        yield* Effect.callback<void>((resume) => {
          if (socket.readyState === socket.CLOSED) return resume(Effect.void)
          socket.once("close", () => resume(Effect.void))
        })
        expect(yield* status).toStrictEqual({ type: "disconnected" })
      }),
    ),
  )

  it.live("starts one thread from an allowed member's mention and marks the mention with eyes", () =>
    stage(({ fake, projectId }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId)
        yield* connected
        yield* fake.mention(question)

        expect(yield* Queue.take(fake.reactions)).toStrictEqual({
          channel: "C1",
          timestamp: question.ts,
          name: "eyes",
        })
        const [run] = yield* runsUntil(routine.id, 1)
        expect(run).toMatchObject({ source: "event", status: "started" })
        const [prompt] = yield* userTexts(run!.threadId, 1)
        expect(prompt).toMatch(/^Answer the question\n\n```json\n/)
        expect(quotedIn(prompt)).toMatchObject({
          event: "slack.mention",
          from: "U1",
          text: question.text,
          url: "https://acme.slack.com/archives/C1/p1700000000000100",
          context: { thread: [] },
        })
      }),
    ),
  )

  it.live("starts nothing for another member, another channel or a redelivered envelope", () =>
    stage(({ fake, projectId }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId)
        yield* connected
        yield* fake.mention(question)
        yield* Queue.take(fake.reactions)

        yield* fake.deliver({ event: { type: "app_mention", ...question } })
        yield* fake.mention({ ...question, ts: "1700000001.000100", user: "U2" })
        yield* fake.mention({ ...question, ts: "1700000002.000100", channel: "C2" })
        const later = { ...question, ts: "1700000003.000100" }
        yield* fake.mention(later)

        expect((yield* Queue.take(fake.reactions)).timestamp).toBe(later.ts)
        const runs = yield* runsUntil(routine.id, 3)
        expect(runs.map((run) => run.status)).toStrictEqual(["started", "skipped", "started"])
        expect(runs[2]!.threadId).not.toBe(runs[0]!.threadId)
      }),
    ),
  )

  it.live("does not read the Slack thread of a mention no routine listens for", () =>
    stage(({ fake, projectId }) =>
      Effect.gen(function* () {
        yield* triggered(projectId)
        yield* connected
        yield* fake.post(question)
        yield* fake.mention({ ...question, ts: "1700000001.000100", thread_ts: question.ts, user: "U2" })
        const allowed = { ...question, ts: "1700000002.000100" }
        yield* fake.mention(allowed)

        expect((yield* Queue.take(fake.reactions)).timestamp).toBe(allowed.ts)
        expect(yield* fake.called("conversations.replies")).toBe(0)
      }),
    ),
  )

  it.live("continues the same thread from a later mention in the Slack thread, with the messages before it", () =>
    stage(({ fake, projectId }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId)
        yield* connected
        yield* fake.mention(question)
        const [first] = yield* runsUntil(routine.id, 1)
        yield* finished(first!.threadId)

        yield* fake.post({
          channel: "C1",
          ts: "1700000100.000100",
          thread_ts: question.ts,
          user: "U2",
          text: "Lint fails",
        })
        const followUp = {
          channel: "C1",
          ts: "1700000200.000100",
          thread_ts: question.ts,
          user: "U1",
          text: "<@UBOT> and now?",
        }
        yield* fake.mention(followUp)
        yield* fake.post({ channel: "C1", ts: "1700000300.000100", thread_ts: question.ts, user: "U2", text: "Later" })

        const [, second] = yield* runsUntil(routine.id, 2)
        expect(second).toMatchObject({ status: "started", threadId: first!.threadId })
        const texts = yield* userTexts(first!.threadId, 2)
        expect(texts[1]).toContain(FOLLOW_UP)
        expect(quotedIn(texts[1])).toMatchObject({
          text: "<@UBOT> and now?",
          url: "https://acme.slack.com/archives/C1/p1700000200000100?thread_ts=1700000000.000100&cid=C1",
          context: {
            thread: [
              { from: "U1", text: question.text },
              { from: "U2", text: "Lint fails" },
            ],
          },
        })
        expect((yield* Queue.take(fake.reactions)).timestamp).toBe(question.ts)
        expect((yield* Queue.take(fake.reactions)).timestamp).toBe(followUp.ts)
      }),
    ),
  )

  it.live("quotes at most the last 20 earlier messages of the Slack thread", () =>
    stage(({ fake, projectId }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId)
        yield* connected
        const root = { channel: "C1", ts: "1700000000.000100", user: "U2", text: "message 0" }
        yield* fake.post(root)
        for (let index = 1; index < 25; index++) {
          yield* fake.post({
            ...root,
            ts: `${1700000000 + index}.000100`,
            thread_ts: root.ts,
            text: `message ${index}`,
          })
        }
        yield* fake.mention({
          channel: "C1",
          ts: "1700000100.000100",
          thread_ts: root.ts,
          user: "U1",
          text: "<@UBOT> sum up",
        })

        const [run] = yield* runsUntil(routine.id, 1)
        const [prompt] = yield* userTexts(run!.threadId, 1)
        const { thread } = quotedIn(prompt).context
        expect(thread.map((message) => message.text)).toStrictEqual(
          Array.from({ length: 20 }, (_, index) => `message ${index + 5}`),
        )
      }),
    ),
  )

  it.live("starts the run with an empty thread when Slack will not hand the thread over", () =>
    stage(({ fake, projectId }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId)
        yield* connected
        yield* fake.fail("conversations.replies")
        yield* fake.mention({
          channel: "C1",
          ts: "1700000100.000100",
          thread_ts: question.ts,
          user: "U1",
          text: "<@UBOT> hi",
        })

        const [run] = yield* runsUntil(routine.id, 1)
        expect(run!.status).toBe("started")
        const [prompt] = yield* userTexts(run!.threadId, 1)
        expect(quotedIn(prompt).context).toStrictEqual({ thread: [] })
      }),
    ),
  )

  it.live("posts into the Slack thread, and refuses once disconnected", () =>
    stage(({ fake }) =>
      Effect.gen(function* () {
        const slack = yield* Slack
        const destination = {
          source: "slack" as const,
          channel: "C1",
          threadTs: question.ts,
          url: "https://acme.slack.com/",
        }
        yield* connected
        yield* fake.post(question)
        yield* slack.post(destination, "It is the lint step.")
        expect(yield* Queue.take(fake.posts)).toMatchObject({
          channel: "C1",
          thread_ts: question.ts,
          text: "It is the lint step.",
        })

        yield* slack.disconnect
        const refused = yield* Effect.flip(slack.post(destination, "Again"))
        expect(refused.message).toBe("Slack is not connected on this machine.")
      }),
    ),
  )
})
