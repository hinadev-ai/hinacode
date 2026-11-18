import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Queue } from "effect"
import { SqlClient } from "effect/sql"
import { McpCredentials } from "../../mcp/credentials.ts"
import { Events } from "../Events.ts"
import { Routines } from "../routines/Routines.ts"
import { type Harness, makeLayer, makeRepo, unusedPort } from "../routines/testing.ts"
import { Settings } from "../Settings.ts"
import { Threads } from "../Threads.ts"
import { type FakeMessage, type FakeSlack, type FakeWorkspace, makeFakeSlack } from "./fakeSlack.ts"
import { layer as slackLayer, Slack } from "./Slack.ts"
import { HEARD_REACTION, layer as asksLayer } from "./SlackAsks.ts"

const workspace: FakeWorkspace = {
  appToken: "xapp-1-fake",
  botToken: "xoxb-fake",
  team: { id: "T1", name: "Acme" },
  bot: "hinacode",
  users: {
    U1: { team_id: "T1", name: "dev", real_name: "Dev Eloper" },
    U2: { team_id: "T1", name: "mei", real_name: "Mei" },
  },
}
const owner = { teamId: "T1", userId: "U1", name: "Dev Eloper" }

const report: FakeMessage = { channel: "C1", ts: "1700000000.000100", user: "U2", text: "gift cards return 500" }
const handover: FakeMessage = {
  channel: "C1",
  ts: "1700000100.000200",
  thread_ts: report.ts,
  user: "U1",
  text: "<@UBOT> look into this",
}
const permalink = "https://acme.slack.com/archives/C1/p1700000000000100"

const repo = makeRepo()
afterAll(() => rmSync(repo, { recursive: true, force: true }))

interface Stage extends Harness {
  readonly fake: FakeSlack
  readonly routineId: string
}

const stage = <E, R>(run: (stage: Stage) => Effect.Effect<void, E, R>, picked = true) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeSlack(workspace)
    const harness: Harness = { pushes: [], jobs: new Map() }
    const events = Layer.succeed(Events, { publish: (event) => Effect.sync(() => void harness.pushes.push(event)) })
    const app = asksLayer.pipe(
      Layer.provideMerge(slackLayer({ apiUrl: fake.apiUrl })),
      Layer.provide(events),
      Layer.provideMerge(makeLayer(harness, yield* unusedPort)),
    )
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const now = new Date(0).toISOString()
      const projectId = crypto.randomUUID()
      yield* sql`INSERT INTO project ${sql.insert({ id: projectId, name: "demo", rootPath: repo, createdAt: now, updatedAt: now })}`
      yield* McpCredentials.use((credentials) => credentials.listening("http://127.0.0.1:1/mcp"))
      const routine = yield* Routines.use((routines) =>
        routines.create({
          projectId,
          name: "Answer Slack",
          enabled: true,
          prompt: "Investigate what the developer asked.",
          provider: "claude",
          model: "test-model",
          effort: null,
          workspace: "local",
          schedule: null,
        }),
      )
      const settings = yield* Settings
      yield* settings.set({ experimental: { slack: true }, slack: { owner, routineId: picked ? routine.id : null } })
      yield* Slack.use((slack) => slack.connect({ appToken: workspace.appToken, botToken: workspace.botToken }))
      yield* Queue.take(fake.links)
      yield* run({ fake, routineId: routine.id, ...harness })
    }).pipe(Effect.provide(app))
  }).pipe(Effect.scoped)

const say = (fake: FakeSlack, message: FakeMessage, type: "app_mention" | "message" = "app_mention") =>
  Effect.andThen(
    fake.post(message),
    fake.deliver({
      team_id: "T1",
      event: { type, ...(type === "message" && { channel_type: "im" }), ...message },
    }),
  )

const runsOf = (routineId: string) => Routines.use((routines) => routines.runs(routineId, 20))

const finished = (threadId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM message WHERE thread_id = ${threadId ?? ""} AND role = 'assistant'
    `.pipe(Effect.repeat({ until: ([row]) => (row?.count ?? 0) > 0 }))
    return yield* Threads.use((threads) => threads.get(threadId ?? "")).pipe(
      Effect.repeat({ until: (thread) => thread.status === "idle" }),
    )
  })

const firstPrompt = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [message] = yield* sql<{ readonly parts: string }>`
      SELECT parts FROM message WHERE thread_id = ${threadId} AND role = 'user' ORDER BY created_at LIMIT 1
    `
    return message?.parts ?? ""
  })

const strangerHeard = (fake: FakeSlack) =>
  Effect.gen(function* () {
    yield* say(fake, { channel: "C9", ts: "1700000900.000900", user: "U2", text: "<@UBOT> hello" })
    expect(yield* Queue.take(fake.notes)).toEqual({
      channel: "C9",
      user: "U2",
      text: "Only Dev Eloper can ask this HinaCode.",
      thread_ts: null,
    })
  })

describe("slack asks", () => {
  it.live("the developer's mention starts one run with the Slack thread quoted, links it and marks the message", () =>
    stage(({ fake, routineId, pushes }) =>
      Effect.gen(function* () {
        yield* fake.post(report)
        yield* say(fake, handover)

        expect(yield* Queue.take(fake.reactions)).toEqual({
          channel: "C1",
          timestamp: handover.ts,
          name: HEARD_REACTION,
        })
        const [run, ...others] = yield* runsOf(routineId)
        expect(others).toEqual([])
        expect(run).toMatchObject({ source: "slack", status: "started" })
        const thread = yield* finished(run!.threadId)
        const link = { channelId: "C1", threadTs: report.ts, permalink, deliveredTs: handover.ts }
        expect(thread.slack).toEqual(link)
        expect(
          pushes.some(
            (event) => event.type === "thread.updated" && event.thread.id === thread.id && event.thread.slack !== null,
          ),
        ).toBe(true)

        const prompt = yield* firstPrompt(thread.id)
        expect(prompt).toContain("Investigate what the developer asked.")
        expect(prompt).toContain(permalink)
        expect(prompt).toContain('\\"from\\": \\"Mei\\"')
        expect(prompt).toContain("gift cards return 500")
        expect(prompt).toContain('\\"developer\\": true')
        expect(prompt).toContain("@HinaCode look into this")
      }),
    ),
  )

  it.live("starts nothing for a mention it has already handled, linked or not", () =>
    stage(({ fake, routineId }) =>
      Effect.gen(function* () {
        const threads = yield* Threads
        yield* fake.post(report)
        yield* say(fake, handover)
        yield* Queue.take(fake.reactions)
        const [started] = yield* runsOf(routineId)
        yield* finished(started!.threadId)

        yield* fake.deliver({ team_id: "T1", event: { type: "app_mention", ...handover } })
        yield* strangerHeard(fake)
        expect(yield* runsOf(routineId)).toHaveLength(1)

        yield* threads.linkSlack(started!.threadId ?? "", null)
        yield* fake.deliver({ team_id: "T1", event: { type: "app_mention", ...handover } })
        yield* strangerHeard(fake)
        const runs = yield* runsOf(routineId)
        expect(runs.map((run) => run.status).toSorted()).toEqual(["skipped", "started"])
        expect(Option.isNone(yield* threads.bySlack("C1", report.ts))).toBe(true)
        expect(yield* Queue.size(fake.reactions)).toBe(0)
      }),
    ),
  )

  it.live("another user's mention starts nothing and gets a note only they can see", () =>
    stage(({ fake, routineId }) =>
      Effect.gen(function* () {
        yield* strangerHeard(fake)
        expect(yield* runsOf(routineId)).toEqual([])
        expect(yield* Queue.size(fake.reactions)).toBe(0)
      }),
    ),
  )

  it.live("a later mention in a Slack thread that has a thread is refused inside that Slack thread", () =>
    stage(({ fake, routineId }) =>
      Effect.gen(function* () {
        yield* fake.post(report)
        yield* say(fake, handover)
        yield* Queue.take(fake.reactions)
        yield* finished((yield* runsOf(routineId))[0]!.threadId)

        yield* say(fake, { ...handover, ts: "1700000200.000300", text: "<@UBOT> any news?" })

        expect(yield* Queue.take(fake.notes)).toEqual({
          channel: "C1",
          user: "U1",
          text: "This Slack thread already has a HinaCode thread.",
          thread_ts: report.ts,
        })
        expect(yield* runsOf(routineId)).toHaveLength(1)
      }),
    ),
  )

  it.live("a direct message from the developer starts a run", () =>
    stage(({ fake, routineId }) =>
      Effect.gen(function* () {
        yield* say(fake, { channel: "D1", ts: "1700000300.000400", user: "U1", text: "why is CI red?" }, "message")

        expect(yield* Queue.take(fake.reactions)).toMatchObject({ channel: "D1", timestamp: "1700000300.000400" })
        const [run] = yield* runsOf(routineId)
        expect((yield* finished(run!.threadId)).slack).toMatchObject({ channelId: "D1", threadTs: "1700000300.000400" })
      }),
    ),
  )

  it.live("tells the developer to pick a routine when none is picked", () =>
    stage(
      ({ fake, routineId }) =>
        Effect.gen(function* () {
          yield* say(fake, { ...handover, thread_ts: undefined })

          expect(yield* Queue.take(fake.notes)).toEqual({
            channel: "C1",
            user: "U1",
            text: "Pick the routine that answers Slack in HinaCode's settings first.",
            thread_ts: null,
          })
          expect(yield* runsOf(routineId)).toEqual([])
        }),
      false,
    ),
  )

  it.live("starts nothing when the developer turns Slack off while the thread is being read", () =>
    stage(({ fake, routineId }) =>
      Effect.gen(function* () {
        const settings = yield* Settings
        yield* fake.post(report)
        yield* fake.hold("chat.getPermalink")
        yield* say(fake, handover)
        const answerPermalink = yield* Queue.take(fake.held)

        yield* settings.set({ slack: { owner: null } })
        yield* fake.hold(null)
        answerPermalink()

        expect((yield* Queue.take(fake.notes)).text).toBe("This HinaCode is not paired with a Slack user yet.")
        expect(yield* runsOf(routineId)).toEqual([])
      }),
    ),
  )

  it.live("starts nothing when the routine is paused while the thread is being read", () =>
    stage(({ fake, routineId }) =>
      Effect.gen(function* () {
        yield* fake.post(report)
        yield* fake.hold("chat.getPermalink")
        yield* say(fake, handover)
        const answerPermalink = yield* Queue.take(fake.held)

        yield* Routines.use((routines) => routines.update({ id: routineId, enabled: false }))
        yield* fake.hold(null)
        answerPermalink()

        expect((yield* Queue.take(fake.notes)).text).toBe("The routine that answers Slack is paused.")
        expect(yield* runsOf(routineId)).toEqual([])
      }),
    ),
  )

  it.live("tells the developer why when Slack refuses to hand over the thread", () =>
    stage(({ fake, routineId }) =>
      Effect.gen(function* () {
        yield* fake.deliver({ team_id: "T1", event: { type: "app_mention", ...handover } })

        expect((yield* Queue.take(fake.notes)).text).toBe(
          "HinaCode could not start: Slack conversations.replies failed: thread_not_found",
        )
        expect(yield* runsOf(routineId)).toEqual([])
      }),
    ),
  )
})
