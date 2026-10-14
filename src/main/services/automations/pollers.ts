import { Effect, Predicate, Schema } from "effect"
import type { AutomationTrigger } from "../../../shared/domain.ts"

/**
 * Event sources for polling triggers. Each poll takes the stored cursor and returns the events
 * newer than it plus the cursor to store next. They take their transport (`gh`, Linear query,
 * `fetch`) as an argument so the cursor logic is testable without credentials.
 */

export class PollError extends Schema.TaggedError<PollError>()("PollError", { reason: Schema.String }) {
  override get message(): string {
    return this.reason
  }
}

export interface PolledEvent {
  /** Dedup key, unique per automation. */
  readonly key: string
  /** The template context: `{ issue }` or `{ message }`. */
  readonly payload: unknown
}

export interface PollResult {
  /** Oldest first, so threads are created in the order the events happened. */
  readonly events: ReadonlyArray<PolledEvent>
  readonly cursor: string
}

type Trigger<T extends AutomationTrigger["type"]> = Extract<AutomationTrigger, { type: T }>

/** Where a new polling automation starts, so enabling it does not replay old events. */
export const initialCursor = (trigger: AutomationTrigger, now: Date) =>
  trigger.type === "slack.mention" ? (now.getTime() / 1000).toFixed(6) : now.toISOString()

const failWith = (cause: unknown) =>
  new PollError({
    reason:
      Predicate.hasProperty(cause, "message") && typeof cause.message === "string" ? cause.message : String(cause),
  })

const latestIso = (cursor: string, timestamps: ReadonlyArray<string>) =>
  timestamps.reduce((latest, next) => (Date.parse(next) > Date.parse(latest) ? next : latest), cursor)

/** The template payload for an issue, the same shape for GitHub and Linear. */
export interface IssuePayload {
  readonly id: string
  readonly number: number
  /** `#123` on GitHub, `ENG-123` on Linear. */
  readonly identifier: string
  readonly title: string
  readonly body: string
  readonly url: string
  readonly author: string
  readonly labels: ReadonlyArray<string>
  readonly createdAt: string
}

const GithubIssues = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      number: Schema.Number,
      title: Schema.String,
      body: Schema.NullOr(Schema.String),
      html_url: Schema.String,
      created_at: Schema.String,
      user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
      labels: Schema.Array(Schema.Struct({ name: Schema.String })),
      pull_request: Schema.optionalKey(Schema.Unknown),
    }),
  ),
)
const decodeGithubIssues = Schema.decodeUnknownEffect(GithubIssues)

const REPO = /^[\w.-]+\/[\w.-]+$/

/** Runs `gh` with these arguments and returns stdout. */
export type RunGh = (args: ReadonlyArray<string>) => Effect.Effect<string, { readonly message: string }>

/**
 * Open issues created after `cursor`. `since` filters on updated time, so the created-time filter
 * is applied here; pull requests, which the issues endpoint also returns, are dropped.
 */
export const pollGithubIssues = (gh: RunGh, trigger: Trigger<"github.issue">, cursor: string) =>
  Effect.gen(function* () {
    if (!REPO.test(trigger.repo)) return yield* new PollError({ reason: `"${trigger.repo}" is not owner/name` })
    const query = new URLSearchParams({ state: "open", since: cursor, per_page: "50" })
    if (trigger.labels && trigger.labels.length > 0) query.set("labels", trigger.labels.join(","))
    const stdout = yield* gh(["api", `repos/${trigger.repo}/issues?${query}`]).pipe(Effect.mapError(failWith))
    const issues = yield* decodeGithubIssues(stdout).pipe(Effect.mapError(failWith))
    const fresh = issues
      .filter((issue) => issue.pull_request === undefined && Date.parse(issue.created_at) > Date.parse(cursor))
      .toSorted((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    return {
      events: fresh.map((issue) => ({
        key: `github:${issue.id}`,
        payload: {
          issue: {
            id: String(issue.id),
            number: issue.number,
            identifier: `#${issue.number}`,
            title: issue.title,
            body: issue.body ?? "",
            url: issue.html_url,
            author: issue.user?.login ?? "",
            labels: issue.labels.map((label) => label.name),
            createdAt: issue.created_at,
          } satisfies IssuePayload,
        },
      })),
      cursor: latestIso(
        cursor,
        fresh.map((issue) => issue.created_at),
      ),
    } satisfies PollResult
  })

export interface LinearIssueNode {
  readonly id: string
  readonly identifier: string
  readonly number: number
  readonly title: string
  readonly description?: string | null | undefined
  readonly url: string
  readonly createdAt: Date
}

/** The subset of Linear's `IssueFilter` the poller sends. */
export interface LinearIssueFilter {
  readonly team: { readonly key: { readonly eq: string } }
  readonly createdAt: { readonly gt: Date }
  readonly state?: { readonly name: { readonly eqIgnoreCase: string } }
  readonly labels?: { readonly some: { readonly name: { readonly eqIgnoreCase: string } } }
}

export type ListLinearIssues = (filter: LinearIssueFilter) => Promise<ReadonlyArray<LinearIssueNode>>

export const linearFilter = (trigger: Trigger<"linear.issue">, cursor: string): LinearIssueFilter => ({
  team: { key: { eq: trigger.teamKey } },
  createdAt: { gt: new Date(cursor) },
  ...(trigger.stateName ? { state: { name: { eqIgnoreCase: trigger.stateName } } } : {}),
  ...(trigger.label ? { labels: { some: { name: { eqIgnoreCase: trigger.label } } } } : {}),
})

export const pollLinearIssues = (list: ListLinearIssues, trigger: Trigger<"linear.issue">, cursor: string) =>
  Effect.gen(function* () {
    const nodes = yield* Effect.tryPromise({ try: () => list(linearFilter(trigger, cursor)), catch: failWith })
    const fresh = nodes
      .filter((issue) => issue.createdAt.getTime() > Date.parse(cursor))
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    return {
      events: fresh.map((issue) => ({
        key: `linear:${issue.id}`,
        payload: {
          issue: {
            id: issue.id,
            number: issue.number,
            identifier: issue.identifier,
            title: issue.title,
            body: issue.description ?? "",
            url: issue.url,
            author: "",
            labels: trigger.label ? [trigger.label] : [],
            createdAt: issue.createdAt.toISOString(),
          } satisfies IssuePayload,
        },
      })),
      cursor: latestIso(
        cursor,
        fresh.map((issue) => issue.createdAt.toISOString()),
      ),
    } satisfies PollResult
  })

const SlackSearch = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
  Schema.Struct({
    ok: Schema.Literal(true),
    messages: Schema.Struct({
      matches: Schema.Array(
        Schema.Struct({
          ts: Schema.String,
          text: Schema.String,
          user: Schema.optionalKey(Schema.String),
          username: Schema.optionalKey(Schema.String),
          permalink: Schema.optionalKey(Schema.String),
          channel: Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) }),
        }),
      ),
    }),
  }),
])
const decodeSlackSearch = Schema.decodeUnknownEffect(SlackSearch)

export type Fetch = (input: URL, init: RequestInit) => Promise<Response>

/**
 * Messages mentioning the bot, through `search.messages`. Slack only allows that method with a
 * user token (xoxp-), which is why this is search rather than `conversations.history`: history
 * needs a channel id per poll, search covers every channel the token can read.
 */
export const pollSlackMentions = (fetch: Fetch, token: string, trigger: Trigger<"slack.mention">, cursor: string) =>
  Effect.gen(function* () {
    const url = new URL("https://slack.com/api/search.messages")
    const query = trigger.channel ? `<@${trigger.botUserId}> in:${trigger.channel}` : `<@${trigger.botUserId}>`
    url.search = new URLSearchParams({ query, sort: "timestamp", sort_dir: "desc", count: "50" }).toString()
    const body = yield* Effect.tryPromise({
      try: async () => (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json(),
      catch: failWith,
    })
    const result = yield* decodeSlackSearch(body).pipe(Effect.mapError(failWith))
    if (!result.ok) return yield* new PollError({ reason: `Slack search.messages: ${result.error}` })
    const fresh = result.messages.matches
      .filter((match) => Number(match.ts) > Number(cursor))
      .toSorted((a, b) => Number(a.ts) - Number(b.ts))
    return {
      events: fresh.map((match) => ({
        key: `slack:${match.channel.id}:${match.ts}`,
        payload: {
          message: {
            text: match.text,
            user: match.user ?? "",
            username: match.username ?? "",
            ts: match.ts,
            permalink: match.permalink ?? "",
            channel: match.channel.name ?? match.channel.id,
          },
        },
      })),
      cursor: fresh.at(-1)?.ts ?? cursor,
    } satisfies PollResult
  })
