import { randomInt } from "node:crypto"
import {
  Clock,
  Context,
  Duration,
  Effect,
  FiberHandle,
  FiberSet,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import type { SlackStatus, SlackTokens } from "../../../shared/domain.ts"
import type { PersistenceError } from "../errors.ts"
import { Events } from "../Events.ts"
import { Secrets } from "../Secrets.ts"
import { Settings } from "../Settings.ts"
import { makeSlackApi, retryWhileRecoverable, type SlackUser } from "./api.ts"
import { decide, DirectMessage } from "./slackInbound.ts"
import { listen, type SlackEnvelope } from "./socket.ts"

export const APP_TOKEN_SECRET = "slack.appToken"
export const BOT_TOKEN_SECRET = "slack.botToken"
export const PAIRING_LIFE = Duration.minutes(10)
export const PAIRED_REACTION = "white_check_mark"

const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
const PAIRING_LENGTH = 8

export class Slack extends Context.Service<
  Slack,
  {
    readonly status: Effect.Effect<SlackStatus, PersistenceError>
    readonly connect: (tokens: SlackTokens) => Effect.Effect<SlackStatus, PersistenceError>
    readonly disconnect: Effect.Effect<SlackStatus, PersistenceError>
    readonly pair: Effect.Effect<SlackStatus, PersistenceError>
    readonly sync: Effect.Effect<void>
  }
>()("hinacode/Slack") {}

interface Bot {
  readonly teamId: string
  readonly team: string
  readonly user: string
}

type Link = Exclude<SlackStatus, { readonly type: "connected" }> | { readonly type: "connected"; readonly bot: Bot }

const decodeDirectMessage = Schema.decodeUnknownOption(DirectMessage)

const newPairingCode = () =>
  Array.from({ length: PAIRING_LENGTH }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join("")

const displayName = (user: SlackUser) => user.profile?.display_name || user.real_name || user.name

const make = ({ apiUrl }: { readonly apiUrl: string }) =>
  Effect.gen(function* () {
    const settings = yield* Settings
    const secrets = yield* Secrets
    const events = yield* Events
    const api = makeSlackApi(apiUrl)
    const listener = yield* FiberHandle.make<void>()
    const expiry = yield* FiberHandle.make<void>()
    const notify = yield* FiberSet.makeRuntime<never, void, never>()
    const reconciling = yield* Semaphore.make(1)

    let link: Link = { type: "disconnected" }
    let listening: SlackTokens | null = null
    let pairing: { readonly code: string; readonly expiresAt: number } | null = null

    const announce = events.publish({ type: "slack.changed" })

    const pairingCode = Effect.map(Clock.currentTimeMillis, (now) => {
      if (pairing !== null && pairing.expiresAt <= now) pairing = null
      return pairing?.code ?? null
    })

    const status = Effect.gen(function* () {
      if (link.type !== "connected") return link
      const { slack } = yield* settings.get
      return {
        type: "connected" as const,
        team: link.bot.team,
        botUser: link.bot.user,
        owner: slack.owner?.teamId === link.bot.teamId ? slack.owner : null,
        pairingCode: yield* pairingCode,
      }
    })

    const receive = (tokens: SlackTokens, bot: Bot, envelope: SlackEnvelope) =>
      Effect.gen(function* () {
        if (envelope.type !== "events_api" || listening !== tokens) return
        const message = decodeDirectMessage(envelope.payload)
        if (Option.isNone(message)) return
        const decision = decide(message.value, { pairingCode: yield* pairingCode })
        if (decision.type === "ignore") return
        pairing = null
        yield* FiberHandle.clear(expiry)
        yield* Effect.gen(function* () {
          const user = yield* api.userInfo(tokens.botToken, decision.userId)
          if (user.team_id !== bot.teamId || user.is_bot === true || user.deleted === true) return
          const owner = { teamId: bot.teamId, userId: decision.userId, name: displayName(user) }
          yield* settings.set({ slack: { owner } })
          yield* api.addReaction(tokens.botToken, decision.message, PAIRED_REACTION)
        }).pipe(Effect.ensuring(announce))
      }).pipe(Effect.catch((error) => Effect.logWarning("could not handle a Slack event", error.message)))

    const session = (tokens: SlackTokens) =>
      Effect.gen(function* () {
        const auth = yield* retryWhileRecoverable(api.authTest(tokens.botToken))
        const bot = { teamId: auth.team_id, team: auth.team, user: auth.user }
        return yield* listen({
          open: api.openConnection(tokens.appToken),
          onLive: (live) => {
            if (listening !== tokens) return
            link = live ? { type: "connected", bot } : { type: "connecting" }
            notify(announce)
          },
          onEnvelope: (envelope) => receive(tokens, bot, envelope),
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.suspend(() => {
            if (listening !== tokens) return Effect.void
            link = { type: "failed", reason: error.reason }
            return announce
          }),
        ),
      )

    const storedTokens = Effect.gen(function* () {
      const { experimental } = yield* settings.get
      if (!experimental.slack) return null
      const appToken = yield* secrets.get(APP_TOKEN_SECRET)
      const botToken = yield* secrets.get(BOT_TOKEN_SECRET)
      return Option.isSome(appToken) && Option.isSome(botToken)
        ? { appToken: appToken.value, botToken: botToken.value }
        : null
    })

    const reconcile = (restart: boolean) =>
      Effect.gen(function* () {
        const tokens = yield* storedTokens
        const unchanged = tokens?.appToken === listening?.appToken && tokens?.botToken === listening?.botToken
        if (unchanged && !restart) return
        listening = tokens
        pairing = null
        if (tokens === null) {
          yield* FiberHandle.clear(listener)
          link = { type: "disconnected" }
        } else {
          link = { type: "connecting" }
          yield* FiberHandle.run(listener, session(tokens))
        }
        yield* announce
      }).pipe(reconciling.withPermits(1))

    const pair = Effect.gen(function* () {
      if (link.type === "connected") {
        pairing = {
          code: newPairingCode(),
          expiresAt: (yield* Clock.currentTimeMillis) + Duration.toMillis(PAIRING_LIFE),
        }
        yield* FiberHandle.run(expiry, Effect.andThen(Effect.sleep(PAIRING_LIFE), announce))
        yield* announce
      }
      return yield* status
    })

    const follow = reconcile(false).pipe(
      Effect.catch((error) => Effect.logWarning("could not follow the Slack settings", error.message)),
    )
    yield* follow
    yield* (yield* settings.changes).pipe(
      Stream.runForEach(() => follow),
      Effect.forkScoped,
    )

    return Slack.of({
      status,
      connect: (tokens) =>
        Effect.gen(function* () {
          yield* secrets.set(APP_TOKEN_SECRET, tokens.appToken)
          yield* secrets.set(BOT_TOKEN_SECRET, tokens.botToken)
          yield* reconcile(true)
          return yield* status
        }),
      disconnect: Effect.gen(function* () {
        yield* secrets.clear(APP_TOKEN_SECRET)
        yield* secrets.clear(BOT_TOKEN_SECRET)
        yield* settings.set({ slack: { owner: null } })
        yield* reconcile(false)
        return yield* status
      }),
      pair,
      sync: follow,
    })
  })

export const layer = (options: { readonly apiUrl: string }) => Layer.effect(Slack, make(options))
