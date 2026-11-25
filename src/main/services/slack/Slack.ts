import { Context, Effect, FiberHandle, FiberSet, Layer, Option, Schema, Semaphore } from "effect"
import type { ReplyDestination, SlackStatus, SlackTokens } from "../../../shared/domain.ts"
import type { PersistenceError } from "../errors.ts"
import { Events } from "../Events.ts"
import { Routines } from "../routines/Routines.ts"
import { type Arrival, slackArrival } from "../routines/triggers.ts"
import { Secrets } from "../Secrets.ts"
import { makeSlackApi, retryWhileRecoverable, type SlackApiError, type SlackMessage, type SlackPlace } from "./api.ts"
import { listen, type SlackEnvelope } from "./socket.ts"

export const APP_TOKEN_SECRET = "slack.appToken"
export const BOT_TOKEN_SECRET = "slack.botToken"
export const SEEN_REACTION = "eyes"
export const THREAD_CONTEXT_MESSAGES = 20

export type SlackDestination = Extract<ReplyDestination, { readonly source: "slack" }>

export class SlackNotConnected extends Schema.TaggedError<SlackNotConnected>()("SlackNotConnected", {}) {
  override get message(): string {
    return "Slack is not connected on this machine."
  }
}

export class Slack extends Context.Service<
  Slack,
  {
    readonly status: Effect.Effect<SlackStatus>
    readonly connect: (tokens: SlackTokens) => Effect.Effect<SlackStatus, PersistenceError>
    readonly disconnect: Effect.Effect<SlackStatus, PersistenceError>
    readonly post: (
      destination: SlackDestination,
      text: string,
    ) => Effect.Effect<void, SlackApiError | SlackNotConnected>
  }
>()("hinacode/Slack") {}

interface SlackBot {
  readonly team: string
  readonly user: string
  readonly url: string
}

type Link =
  | Exclude<SlackStatus, { readonly type: "connected" }>
  | { readonly type: "connected"; readonly bot: SlackBot }

const decodeMentionPlace = Schema.decodeUnknownOption(
  Schema.Struct({ event: Schema.Struct({ channel: Schema.String, ts: Schema.String }) }),
)

const timeOf = (ts: string) => ts.split(".").map(Number)

const isBefore = (ts: string, other: string) => {
  const [seconds = 0, micros = 0] = timeOf(ts)
  const [otherSeconds = 0, otherMicros = 0] = timeOf(other)
  return seconds < otherSeconds || (seconds === otherSeconds && micros < otherMicros)
}

const quoted = (message: SlackMessage) => ({
  from: message.user ?? message.username ?? message.bot_id ?? "",
  text: message.text ?? "",
})

const make = ({ apiUrl }: { readonly apiUrl: string }) =>
  Effect.gen(function* () {
    const secrets = yield* Secrets
    const events = yield* Events
    const routines = yield* Routines
    const api = makeSlackApi(apiUrl)
    const listener = yield* FiberHandle.make<void>()
    const notify = yield* FiberSet.makeRuntime<never, void, never>()
    const changing = Semaphore.makeUnsafe(1)
    const receiving = Semaphore.makeUnsafe(1)

    let link: Link = { type: "disconnected" }
    let listening: SlackTokens | null = null

    const announce = events.publish({ type: "slack.changed" })

    const status = Effect.sync((): SlackStatus =>
      link.type === "connected" ? { type: "connected", team: link.bot.team, botUser: link.bot.user } : link,
    )

    const earlierMessages = (botToken: string, arrival: Arrival, mention: SlackPlace) => {
      const { destination } = arrival
      if (destination.source !== "slack" || destination.threadTs === mention.ts) return Effect.succeed([])
      return api.replies(botToken, { channel: mention.channel, ts: destination.threadTs }).pipe(
        Effect.map((messages) =>
          messages
            .filter((message) => isBefore(message.ts, mention.ts))
            .slice(-THREAD_CONTEXT_MESSAGES)
            .map(quoted),
        ),
        Effect.catch((error) =>
          Effect.as(Effect.logWarning("could not read the Slack thread of a mention", error.message), []),
        ),
      )
    }

    const receive = (tokens: SlackTokens, bot: SlackBot, envelope: SlackEnvelope) =>
      Effect.gen(function* () {
        if (envelope.type !== "events_api" || listening !== tokens) return
        const arrival = slackArrival(envelope.payload, bot.url)
        const mention = decodeMentionPlace(envelope.payload)
        if (arrival === null || Option.isNone(mention)) return
        if (!(yield* routines.listensFor(arrival))) return
        const thread = yield* earlierMessages(tokens.botToken, arrival, mention.value.event)
        const runs = yield* routines.arrive({ ...arrival, context: { thread } })
        if (!runs.some((run) => run.status === "started")) return
        yield* api
          .addReaction(tokens.botToken, mention.value.event, SEEN_REACTION)
          .pipe(Effect.catch((error) => Effect.logWarning("could not mark a Slack mention as seen", error.message)))
      }).pipe(
        Semaphore.withPermit(receiving),
        Effect.catchCause((cause) => Effect.logWarning("could not handle a Slack event", cause)),
      )

    const session = (tokens: SlackTokens) =>
      Effect.gen(function* () {
        const auth = yield* retryWhileRecoverable(api.authTest(tokens.botToken))
        const bot = { team: auth.team, user: auth.user, url: auth.url }
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
        if (tokens === null) {
          yield* FiberHandle.clear(listener)
          link = { type: "disconnected" }
        } else {
          link = { type: "connecting" }
          yield* FiberHandle.run(listener, session(tokens))
        }
        yield* announce
      })

    yield* reconcile(false).pipe(
      Effect.catch((error) => Effect.logWarning("could not read the stored Slack tokens", error.message)),
    )

    return Slack.of({
      status,
      connect: (tokens) =>
        Effect.gen(function* () {
          yield* secrets.set(APP_TOKEN_SECRET, tokens.appToken)
          yield* secrets.set(BOT_TOKEN_SECRET, tokens.botToken)
          yield* reconcile(true)
          return yield* status
        }).pipe(Semaphore.withPermit(changing)),
      disconnect: Effect.gen(function* () {
        yield* secrets.clear(APP_TOKEN_SECRET)
        yield* secrets.clear(BOT_TOKEN_SECRET)
        yield* reconcile(false)
        return yield* status
      }).pipe(Semaphore.withPermit(changing)),
      post: (destination, text) =>
        Effect.suspend((): Effect.Effect<unknown, SlackApiError | SlackNotConnected> =>
          listening === null
            ? Effect.fail(new SlackNotConnected())
            : api.postMessage(listening.botToken, { channel: destination.channel, ts: destination.threadTs }, text),
        ).pipe(Effect.asVoid),
    })
  })

export const layer = (options: { readonly apiUrl: string }) => Layer.effect(Slack, make(options))
