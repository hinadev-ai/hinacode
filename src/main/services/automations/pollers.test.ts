import { createHmac } from "node:crypto"
import { describe, expect, it, test } from "@effect/vitest"
import { Effect } from "effect"
import {
  type Fetch,
  initialCursor,
  type LinearIssueFilter,
  type LinearIssueNode,
  pollGithubIssues,
  pollLinearIssues,
  pollSlackMentions,
} from "./pollers.ts"
import { renderTemplate, slugifyBranch, titleFromPrompt } from "./template.ts"
import { signatureMatches } from "./webhook.ts"

const fakeFetch =
  (body: unknown, requests: Array<{ url: URL; init: RequestInit }> = []): Fetch =>
  async (url, init) => {
    requests.push({ url, init })
    return new Response(JSON.stringify(body))
  }
const match = (ts: string) => ({
  ts,
  text: `<@U1> please look ${ts}`,
  user: "U9",
  permalink: `https://x.slack.com/p${ts}`,
  channel: { id: "C1", name: "general" },
})

const issue = (id: number, createdAt: string, extra: object = {}) => ({
  id,
  number: id,
  title: `Issue ${id}`,
  body: null,
  html_url: `https://github.com/a/b/issues/${id}`,
  created_at: createdAt,
  user: { login: "octocat" },
  labels: [{ name: "bug" }],
  ...extra,
})
const node = (id: string, createdAt: string): LinearIssueNode => ({
  id,
  identifier: `ENG-${id}`,
  number: Number(id),
  title: `Linear ${id}`,
  description: "details",
  url: `https://linear.app/x/issue/ENG-${id}`,
  createdAt: new Date(createdAt),
})
const rejectUnauthenticated = async (): Promise<ReadonlyArray<LinearIssueNode>> => {
  throw new Error("Authentication required")
}

describe("initialCursor", () => {
  const now = new Date("2026-10-12T03:00:00.000Z")

  test("starts timestamp sources at now", () => {
    expect(initialCursor({ type: "github.issue", repo: "a/b" }, now)).toBe("2026-10-12T03:00:00.000Z")
  })

  test("starts Slack at now as a message ts", () => {
    expect(initialCursor({ type: "slack.mention", botUserId: "U1" }, now)).toBe("1791774000.000000")
  })
})

describe("pollGithubIssues", () => {
  const cursor = "2026-10-12T03:00:00.000Z"

  it.effect("returns issues created after the cursor, oldest first, and advances the cursor", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = []
      const gh = (args: ReadonlyArray<string>) => {
        calls.push(args)
        return Effect.succeed(
          JSON.stringify([
            issue(3, "2026-10-12T03:05:00Z"),
            issue(2, "2026-10-12T03:01:00Z"),
            issue(1, "2026-10-12T02:00:00Z"),
            issue(4, "2026-10-12T03:06:00Z", { pull_request: { url: "x" } }),
          ]),
        )
      }
      const result = yield* pollGithubIssues(gh, { type: "github.issue", repo: "a/b", labels: ["bug"] }, cursor)

      expect(result.events.map((event) => event.key)).toStrictEqual(["github:2", "github:3"])
      expect(result.cursor).toBe("2026-10-12T03:05:00Z")
      expect(result.events[0]?.payload).toStrictEqual({
        issue: {
          id: "2",
          number: 2,
          identifier: "#2",
          title: "Issue 2",
          body: "",
          url: "https://github.com/a/b/issues/2",
          author: "octocat",
          labels: ["bug"],
          createdAt: "2026-10-12T03:01:00Z",
        },
      })
      const url = new URL(calls[0]?.[1] ?? "", "https://api.github.com/")
      expect(url.pathname).toBe("/repos/a/b/issues")
      expect(url.searchParams.get("since")).toBe(cursor)
      expect(url.searchParams.get("labels")).toBe("bug")
    }),
  )

  it.effect("keeps the cursor when nothing is new", () =>
    Effect.gen(function* () {
      const stdout = JSON.stringify([issue(1, "2026-10-12T02:00:00Z")])
      const result = yield* pollGithubIssues(
        () => Effect.succeed(stdout),
        { type: "github.issue", repo: "a/b" },
        cursor,
      )
      expect(result).toStrictEqual({ events: [], cursor })
    }),
  )

  it.effect("rejects a repo that is not owner/name before calling gh", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        pollGithubIssues(() => Effect.die("gh must not run"), { type: "github.issue", repo: "a/b/../c" }, cursor),
      )
      expect(error.message).toMatch(/owner\/name/)
    }),
  )

  it.effect("surfaces gh failures as PollError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        pollGithubIssues(
          () => Effect.fail({ message: "API rate limit exceeded" }),
          { type: "github.issue", repo: "a/b" },
          cursor,
        ),
      )
      expect(error._tag).toBe("PollError")
      expect(error.message).toBe("API rate limit exceeded")
    }),
  )
})

describe("pollLinearIssues", () => {
  const cursor = "2026-10-12T03:00:00.000Z"

  it.effect("filters by team, state, label and createdAt, then advances the cursor", () =>
    Effect.gen(function* () {
      const filters: Array<LinearIssueFilter> = []
      const list = async (filter: LinearIssueFilter) => {
        filters.push(filter)
        return [node("9", "2026-10-12T03:09:00Z"), node("7", "2026-10-12T03:07:00Z"), node("1", cursor)]
      }
      const result = yield* pollLinearIssues(
        list,
        { type: "linear.issue", teamKey: "ENG", stateName: "Todo", label: "bot" },
        cursor,
      )

      expect(filters[0]).toStrictEqual({
        team: { key: { eq: "ENG" } },
        createdAt: { gt: new Date(cursor) },
        state: { name: { eqIgnoreCase: "Todo" } },
        labels: { some: { name: { eqIgnoreCase: "bot" } } },
      })
      expect(result.events.map((event) => event.key)).toStrictEqual(["linear:7", "linear:9"])
      expect(result.cursor).toBe("2026-10-12T03:09:00.000Z")
    }),
  )

  it.effect("omits optional filters", () =>
    Effect.gen(function* () {
      const filters: Array<LinearIssueFilter> = []
      yield* pollLinearIssues(
        async (filter) => {
          filters.push(filter)
          return []
        },
        { type: "linear.issue", teamKey: "ENG" },
        cursor,
      )
      expect(Object.keys(filters[0] ?? {})).toStrictEqual(["team", "createdAt"])
    }),
  )

  it.effect("turns SDK rejections into PollError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        pollLinearIssues(rejectUnauthenticated, { type: "linear.issue", teamKey: "ENG" }, cursor),
      )
      expect(error.message).toBe("Authentication required")
    }),
  )
})

describe("pollSlackMentions", () => {
  const cursor = "1791774000.000000"

  it.effect("searches for the bot mention and returns newer messages, oldest first", () =>
    Effect.gen(function* () {
      const requests: Array<{ url: URL; init: RequestInit }> = []
      const body = {
        ok: true,
        messages: { matches: [match("1791774100.000200"), match("1791774050.000100"), match(cursor)] },
      }
      const result = yield* pollSlackMentions(
        fakeFetch(body, requests),
        "xoxp-1",
        { type: "slack.mention", botUserId: "U1", channel: "#general" },
        cursor,
      )

      expect(requests[0]?.url.searchParams.get("query")).toBe("<@U1> in:#general")
      expect(requests[0]?.url.searchParams.get("sort")).toBe("timestamp")
      expect(requests[0]?.init.headers).toStrictEqual({ Authorization: "Bearer xoxp-1" })
      expect(result.events.map((event) => event.key)).toStrictEqual([
        "slack:C1:1791774050.000100",
        "slack:C1:1791774100.000200",
      ])
      expect(result.cursor).toBe("1791774100.000200")
    }),
  )

  it.effect("keeps the cursor when nothing is new", () =>
    Effect.gen(function* () {
      const body = { ok: true, messages: { matches: [match(cursor)] } }
      const result = yield* pollSlackMentions(fakeFetch(body), "t", { type: "slack.mention", botUserId: "U1" }, cursor)
      expect(result).toStrictEqual({ events: [], cursor })
    }),
  )

  it.effect("reports Slack API errors", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        pollSlackMentions(
          fakeFetch({ ok: false, error: "not_allowed_token_type" }),
          "xoxb",
          { type: "slack.mention", botUserId: "U1" },
          cursor,
        ),
      )
      expect(error.message).toBe("Slack search.messages: not_allowed_token_type")
    }),
  )
})

describe("renderTemplate", () => {
  test("fills nested paths, blanks missing ones and does not escape HTML", () => {
    const payload = { issue: { title: "<b>Crash</b>", number: 12, labels: ["a"] } }
    expect(
      renderTemplate("{{issue.title}} #{{ issue.number }} {{issue.labels}} [{{issue.missing.deep}}]", payload),
    ).toBe('<b>Crash</b> #12 ["a"] []')
  })
})

describe("slugifyBranch", () => {
  test("keeps path segments and strips unsafe characters", () => {
    expect(slugifyBranch("kk/Issue 12: Fix the Thing!")).toBe("kk/issue-12-fix-the-thing")
    expect(slugifyBranch("kk//..bad../x.lock")).toBe("kk/bad/x")
    expect(slugifyBranch("修正")).toBe("")
  })
})

describe("titleFromPrompt", () => {
  test("uses the first non-empty line", () => {
    expect(titleFromPrompt("\n  New issue: crash \nmore", "fallback")).toBe("New issue: crash")
    expect(titleFromPrompt("  ", "fallback")).toBe("fallback")
  })
})

describe("signatureMatches", () => {
  const body = new TextEncoder().encode('{"a":1}')
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

  test("accepts the HMAC of the raw body", () => {
    expect(signatureMatches("s3cret", body, sign("s3cret"))).toBe(true)
  })

  test("rejects a wrong secret, a missing header and a malformed header", () => {
    expect(signatureMatches("s3cret", body, sign("other"))).toBe(false)
    expect(signatureMatches("s3cret", body, undefined)).toBe(false)
    expect(signatureMatches("s3cret", body, "sha256=abc")).toBe(false)
  })
})
