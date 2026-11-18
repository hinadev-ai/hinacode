import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, Option, Queue } from "effect"
import { TestClock } from "effect/testing"
import type { PushEvent } from "../../../shared/contract.ts"
import type { SlackStatus } from "../../../shared/domain.ts"
import * as Db from "../../db/client.ts"
import { Events } from "../Events.ts"
import { layer as secretsLayer, noKeyring, Secrets } from "../Secrets.ts"
import { layer as settingsLayer, Settings } from "../Settings.ts"
import { type FakeSlack, type FakeWorkspace, makeFakeSlack } from "./fakeSlack.ts"
import { APP_TOKEN_SECRET, BOT_TOKEN_SECRET, layer as slackLayer, PAIRED_REACTION, Slack } from "./Slack.ts"

const workspace: FakeWorkspace = {
  appToken: "xapp-1-app",
  botToken: "xoxb-bot",
  team: { id: "T1", name: "Acme" },
  bot: "hinacode",
  users: {
    U1: { team_id: "T1", name: "dev", real_name: "Dev Eloper" },
    U2: { team_id: "T1", name: "mei", real_name: "Mei" },
    U9: { team_id: "T9", name: "guest" },
  },
}
const tokens = { appToken: workspace.appToken, botToken: workspace.botToken }

const directMessage = (user: string, text: string) => ({
  team_id: workspace.team.id,
  event: { type: "message", channel_type: "im", channel: "D1", ts: "1700000000.000100", user, text },
})

interface Stage {
  readonly fake: FakeSlack
  readonly until: <S extends SlackStatus>(wanted: (status: SlackStatus) => status is S) => Effect.Effect<S>
}

type Base = Settings | Secrets

const stage = <E>(
  run: (stage: Stage) => Effect.Effect<void, E, Slack | Base>,
  before: Effect.Effect<void, unknown, Base> = Effect.void,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeSlack(workspace)
    const pushes = yield* Queue.unbounded<PushEvent>()
    const base = yield* Layer.build(
      Layer.mergeAll(
        secretsLayer.pipe(Layer.provide(noKeyring)),
        Layer.suspend(() => settingsLayer(mkdtempSync(join(tmpdir(), "kk-slack-settings-")))),
        Layer.succeed(Events, { publish: (event) => Effect.asVoid(Queue.offer(pushes, event)) }),
      ).pipe(Layer.provide(Db.layer(":memory:")), Layer.provide(NodeServices.layer)),
    )
    yield* Effect.provide(before, base)
    const slack = yield* Effect.provide(Layer.build(slackLayer({ apiUrl: fake.apiUrl })), base)
    const status = Effect.orDie(Context.get(slack, Slack).status)
    const until: Stage["until"] = (wanted) =>
      Effect.flatMap(status, (current) =>
        wanted(current) ? Effect.succeed(current) : Effect.andThen(Queue.take(pushes), until(wanted)),
      )
    yield* Effect.provide(run({ fake, until }), Context.merge(base, slack))
  })

const experimentOn = Settings.use((settings) => settings.set({ experimental: { slack: true } }))

const connected = (status: SlackStatus) => status.type === "connected"
const failed = (status: SlackStatus) => status.type === "failed"

const linked = ({ fake, until }: Stage) =>
  Effect.gen(function* () {
    yield* experimentOn
    yield* Slack.use((slack) => slack.connect(tokens))
    yield* Queue.take(fake.links)
    return yield* until(connected)
  })

describe("slack", () => {
  it.live("stays disconnected until the experiment is on", () =>
    stage((current) =>
      Effect.gen(function* () {
        const slack = yield* Slack
        expect(yield* slack.connect(tokens)).toEqual({ type: "disconnected" })
        expect(slack.enabled()).toBe(false)
        yield* experimentOn
        expect(yield* current.until(connected)).toEqual({
          type: "connected",
          team: "Acme",
          botUser: "hinacode",
          owner: null,
          pairingCode: null,
        })
      }),
    ),
  )

  it.live("connects on startup with the stored tokens", () =>
    stage(
      ({ until }) => Effect.asVoid(until(connected)),
      Effect.gen(function* () {
        const secrets = yield* Secrets
        yield* secrets.set(APP_TOKEN_SECRET, tokens.appToken)
        yield* secrets.set(BOT_TOKEN_SECRET, tokens.botToken)
        yield* experimentOn
      }),
    ),
  )

  it.live("acknowledges an envelope it has no use for", () =>
    stage((current) =>
      Effect.gen(function* () {
        yield* linked(current)
        const envelopeId = yield* current.fake.deliver({ event: { type: "reaction_added" } })
        expect(yield* Queue.take(current.fake.acks)).toBe(envelopeId)
      }),
    ),
  )

  it.live("opens a replacement when Slack asks to refresh, and stays connected when the old socket closes", () =>
    stage((current) =>
      Effect.gen(function* () {
        yield* linked(current)
        yield* current.fake.askToRefresh
        const replacement = yield* Queue.take(current.fake.links)
        yield* current.fake.askToRefresh
        const second = yield* Queue.take(current.fake.links)
        replacement.close()
        const envelopeId = yield* current.fake.deliver({ event: { type: "reaction_added" } })
        expect(second.readyState).toBe(second.OPEN)
        expect(yield* Queue.take(current.fake.acks)).toBe(envelopeId)
        expect((yield* Slack.use((slack) => slack.status)).type).toBe("connected")
      }),
    ),
  )

  it.live("reconnects after the socket drops", () =>
    stage((current) =>
      Effect.gen(function* () {
        yield* linked(current)
        yield* current.fake.drop
        yield* current.until((status) => status.type === "connecting")
        yield* Queue.take(current.fake.links)
        yield* current.until(connected)
      }),
    ),
  )

  it.live("fails with Slack's reason when the app token is revoked while connected", () =>
    stage((current) =>
      Effect.gen(function* () {
        const slack = yield* Slack
        yield* linked(current)
        expect(slack.enabled()).toBe(true)
        yield* current.fake.revokeAppToken
        yield* current.fake.drop
        expect(yield* current.until(failed)).toEqual({ type: "failed", reason: "invalid_auth" })
        expect(slack.enabled()).toBe(false)
      }),
    ),
  )

  it.live("fails on a bot token Slack refuses, and connects once it is replaced", () =>
    stage((current) =>
      Effect.gen(function* () {
        yield* experimentOn
        const slack = yield* Slack
        yield* slack.connect({ ...tokens, botToken: "xoxb-wrong" })
        expect(yield* current.until(failed)).toEqual({ type: "failed", reason: "invalid_auth" })
        yield* slack.connect(tokens)
        yield* current.until(connected)
      }),
    ),
  )

  it.live("pairs the workspace member who sends the code, once", () =>
    stage((current) =>
      Effect.gen(function* () {
        yield* linked(current)
        const slack = yield* Slack
        const waiting = yield* slack.pair
        const code = waiting.type === "connected" ? waiting.pairingCode : null
        expect(code).toMatch(/^[A-Z2-9]{8}$/)

        yield* current.fake.deliver(directMessage("U1", `${code}`))
        const owner = { teamId: "T1", userId: "U1", name: "Dev Eloper" }
        const paired = yield* current.until(
          (status): status is Extract<SlackStatus, { type: "connected" }> =>
            status.type === "connected" && status.owner !== null,
        )
        expect(paired).toMatchObject({ owner, pairingCode: null })
        expect(yield* Queue.take(current.fake.reactions)).toEqual({
          channel: "D1",
          timestamp: "1700000000.000100",
          name: PAIRED_REACTION,
        })
        expect((yield* Settings.use((settings) => settings.get)).slack.owner).toEqual(owner)
      }),
    ),
  )

  it.live("pairs only the first of two members who send the same code", () =>
    stage((current) =>
      Effect.gen(function* () {
        yield* linked(current)
        const slack = yield* Slack
        const waiting = yield* slack.pair
        const code = waiting.type === "connected" ? waiting.pairingCode : null
        yield* current.fake.deliver(directMessage("U2", `${code}`))
        yield* current.fake.deliver(directMessage("U1", `${code}`))
        yield* Queue.take(current.fake.reactions)
        yield* Queue.take(current.fake.acks)
        yield* Queue.take(current.fake.acks)
        expect(yield* slack.status).toMatchObject({ owner: { userId: "U2", name: "Mei" }, pairingCode: null })
        expect(yield* Queue.size(current.fake.reactions)).toBe(0)
      }),
    ),
  )

  it.live("stops listening when a token is cleared behind its back", () =>
    stage(({ fake, until }) =>
      Effect.gen(function* () {
        yield* experimentOn
        const slack = yield* Slack
        yield* slack.connect(tokens)
        const socket = yield* Queue.take(fake.links)
        yield* until(connected)

        yield* Secrets.use((secrets) => secrets.clear(BOT_TOKEN_SECRET))
        yield* slack.sync
        expect(yield* slack.status).toEqual({ type: "disconnected" })
        yield* Effect.callback<void>((resume) => {
          if (socket.readyState === socket.CLOSED) return resume(Effect.void)
          socket.once("close", () => resume(Effect.void))
        })
      }),
    ),
  )

  it.live("spends the code on a sender from another workspace without pairing them", () =>
    stage((current) =>
      Effect.gen(function* () {
        yield* linked(current)
        const slack = yield* Slack
        const waiting = yield* slack.pair
        const code = waiting.type === "connected" ? waiting.pairingCode : null
        yield* current.fake.deliver(directMessage("U9", `${code}`))
        const after = yield* current.until(
          (status): status is Extract<SlackStatus, { type: "connected" }> =>
            status.type === "connected" && status.pairingCode === null,
        )
        expect(after.owner).toBeNull()
      }),
    ),
  )

  it.effect("drops a pairing code after ten minutes", () =>
    stage((current) =>
      Effect.gen(function* () {
        yield* linked(current)
        const slack = yield* Slack
        expect(yield* slack.pair).toMatchObject({ pairingCode: expect.stringMatching(/^[A-Z2-9]{8}$/) })
        yield* TestClock.adjust("9 minutes")
        expect(yield* slack.status).toMatchObject({ pairingCode: expect.any(String) })
        yield* TestClock.adjust("1 minute")
        expect(yield* slack.status).toMatchObject({ pairingCode: null })
      }),
    ),
  )

  it.live("disconnect forgets the tokens and the paired developer", () =>
    stage((current) =>
      Effect.gen(function* () {
        yield* linked(current)
        const slack = yield* Slack
        const waiting = yield* slack.pair
        yield* current.fake.deliver(directMessage("U1", waiting.type === "connected" ? `${waiting.pairingCode}` : ""))
        yield* Queue.take(current.fake.reactions)

        expect(yield* slack.disconnect).toEqual({ type: "disconnected" })
        const secrets = yield* Secrets
        expect(Option.isNone(yield* secrets.get(APP_TOKEN_SECRET))).toBe(true)
        expect(Option.isNone(yield* secrets.get(BOT_TOKEN_SECRET))).toBe(true)
        expect((yield* Settings.use((settings) => settings.get)).slack.owner).toBeNull()
      }),
    ),
  )
})
