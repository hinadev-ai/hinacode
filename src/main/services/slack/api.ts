import { Duration, Effect, Schema } from "effect"

export const SLACK_API_URL = "https://slack.com/api/"

const REQUEST_TIMEOUT_MS = 15_000
const REPLIES_PAGE_SIZE = 200
const REPLIES_MAX_PAGES = 50
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000
const PASSING_REFUSALS = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
])

export class SlackApiError extends Schema.TaggedError<SlackApiError>()("SlackApiError", {
  method: Schema.String,
  reason: Schema.String,
  recoverable: Schema.Boolean,
  retryAfterMs: Schema.NullOr(Schema.Number),
}) {
  override get message(): string {
    return `Slack ${this.method} failed: ${this.reason}`
  }
}

export const backoffMs = (attempt: number) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt)

export const retryWhileRecoverable = <A, R>(
  effect: Effect.Effect<A, SlackApiError, R>,
  attempt = 0,
): Effect.Effect<A, SlackApiError, R> =>
  Effect.catch(effect, (error) =>
    error.recoverable
      ? Effect.andThen(
          Effect.sleep(Duration.millis(Math.max(error.retryAfterMs ?? 0, backoffMs(attempt)))),
          retryWhileRecoverable(effect, attempt + 1),
        )
      : Effect.fail(error),
  )

const Reply = Schema.Struct({ ok: Schema.Boolean, error: Schema.optionalKey(Schema.String) })

const AuthTest = Schema.Struct({
  team_id: Schema.String,
  team: Schema.String,
  user: Schema.String,
  user_id: Schema.String,
})
const Connection = Schema.Struct({ url: Schema.String })
const UserInfo = Schema.Struct({
  user: Schema.Struct({
    team_id: Schema.String,
    name: Schema.String,
    real_name: Schema.optionalKey(Schema.String),
    is_bot: Schema.optionalKey(Schema.Boolean),
    deleted: Schema.optionalKey(Schema.Boolean),
    profile: Schema.optionalKey(Schema.Struct({ display_name: Schema.optionalKey(Schema.String) })),
  }),
})

export type SlackUser = (typeof UserInfo.Type)["user"]

export const SlackMessage = Schema.Struct({
  ts: Schema.String,
  user: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  bot_id: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
})
export type SlackMessage = typeof SlackMessage.Type

const Replies = Schema.Struct({
  messages: Schema.Array(SlackMessage),
  response_metadata: Schema.optionalKey(Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) })),
})
const Permalink = Schema.Struct({ permalink: Schema.String })

export interface SlackPlace {
  readonly channel: string
  readonly ts: string
}

export const displayName = (user: SlackUser) => user.profile?.display_name || user.real_name || user.name

const unexpected = (method: string) => () =>
  new SlackApiError({ method, reason: "unexpected response", recoverable: false, retryAfterMs: null })

const isUnavailable = (status: number) => status === 429 || status >= 500

const retryAfterMs = (header: string | null) => {
  const seconds = Number(header)
  return header !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

export const makeSlackApi = (apiUrl: string) => {
  const call = <A>(
    method: string,
    token: string,
    params: Readonly<Record<string, string>>,
    result: Schema.Codec<A, unknown>,
  ) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: async (signal) => {
          const answered = await fetch(new URL(method, apiUrl), {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: new URLSearchParams(params),
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          })
          return isUnavailable(answered.status)
            ? { status: answered.status, retryAfterMs: retryAfterMs(answered.headers.get("retry-after")) }
            : { status: answered.status, body: (await answered.json()) as unknown }
        },
        catch: (cause) =>
          new SlackApiError({
            method,
            reason: cause instanceof Error ? cause.message : String(cause),
            recoverable: true,
            retryAfterMs: null,
          }),
      })
      if (!("body" in response)) {
        return yield* new SlackApiError({
          method,
          reason: `HTTP ${response.status}`,
          recoverable: true,
          retryAfterMs: response.retryAfterMs,
        })
      }
      const { body } = response
      const reply = yield* Schema.decodeUnknownEffect(Reply)(body).pipe(Effect.mapError(unexpected(method)))
      if (!reply.ok) {
        const reason = reply.error ?? "unknown_error"
        return yield* new SlackApiError({
          method,
          reason,
          recoverable: PASSING_REFUSALS.has(reason),
          retryAfterMs: null,
        })
      }
      return yield* Schema.decodeUnknownEffect(result)(body).pipe(Effect.mapError(unexpected(method)))
    })

  const replies = (
    botToken: string,
    { channel, ts }: SlackPlace,
    cursor = "",
    page = 1,
  ): Effect.Effect<ReadonlyArray<SlackMessage>, SlackApiError> =>
    Effect.flatMap(
      call(
        "conversations.replies",
        botToken,
        { channel, ts, limit: String(REPLIES_PAGE_SIZE), ...(cursor !== "" && { cursor }) },
        Replies,
      ),
      ({ messages, response_metadata }) => {
        const next = response_metadata?.next_cursor ?? ""
        if (next === "") return Effect.succeed(messages)
        if (page >= REPLIES_MAX_PAGES) {
          return Effect.fail(
            new SlackApiError({
              method: "conversations.replies",
              reason: `the thread has more than ${REPLIES_PAGE_SIZE * REPLIES_MAX_PAGES} messages`,
              recoverable: false,
              retryAfterMs: null,
            }),
          )
        }
        return Effect.map(replies(botToken, { channel, ts }, next, page + 1), (rest) => [...messages, ...rest])
      },
    )

  return {
    authTest: (botToken: string) => call("auth.test", botToken, {}, AuthTest),
    replies,
    permalink: (botToken: string, { channel, ts }: SlackPlace) =>
      Effect.map(
        call("chat.getPermalink", botToken, { channel, message_ts: ts }, Permalink),
        ({ permalink }) => permalink,
      ),
    postEphemeral: (
      botToken: string,
      note: {
        readonly channel: string
        readonly user: string
        readonly text: string
        readonly threadTs: string | null
      },
    ) =>
      call(
        "chat.postEphemeral",
        botToken,
        {
          channel: note.channel,
          user: note.user,
          text: note.text,
          ...(note.threadTs !== null && { thread_ts: note.threadTs }),
        },
        Schema.Struct({}),
      ),
    openConnection: (appToken: string) =>
      Effect.map(call("apps.connections.open", appToken, {}, Connection), ({ url }) => url),
    userInfo: (botToken: string, user: string) =>
      Effect.map(call("users.info", botToken, { user }, UserInfo), (info) => info.user),
    addReaction: (botToken: string, message: SlackPlace, name: string) =>
      call("reactions.add", botToken, { channel: message.channel, timestamp: message.ts, name }, Schema.Struct({})),
  }
}

export type SlackApi = ReturnType<typeof makeSlackApi>
