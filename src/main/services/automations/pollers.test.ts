import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { describe, test } from "node:test"
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

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const runFailure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))

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
    assert.equal(initialCursor({ type: "github.issue", repo: "a/b" }, now), "2026-10-12T03:00:00.000Z")
  })

  test("starts Slack at now as a message ts", () => {
    assert.equal(initialCursor({ type: "slack.mention", botUserId: "U1" }, now), "1791774000.000000")
  })
})

describe("pollGithubIssues", () => {
  const cursor = "2026-10-12T03:00:00.000Z"

  test("returns issues created after the cursor, oldest first, and advances the cursor", async () => {
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
    const result = await run(pollGithubIssues(gh, { type: "github.issue", repo: "a/b", labels: ["bug"] }, cursor))

    assert.deepEqual(
      result.events.map((event) => event.key),
      ["github:2", "github:3"],
    )
    assert.equal(result.cursor, "2026-10-12T03:05:00Z")
    assert.deepEqual(result.events[0]?.payload, {
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
    assert.equal(url.pathname, "/repos/a/b/issues")
    assert.equal(url.searchParams.get("since"), cursor)
    assert.equal(url.searchParams.get("labels"), "bug")
  })

  test("keeps the cursor when nothing is new", async () => {
    const stdout = JSON.stringify([issue(1, "2026-10-12T02:00:00Z")])
    const result = await run(
      pollGithubIssues(() => Effect.succeed(stdout), { type: "github.issue", repo: "a/b" }, cursor),
    )
    assert.deepEqual(result, { events: [], cursor })
  })

  test("rejects a repo that is not owner/name before calling gh", async () => {
    const error = await runFailure(
      pollGithubIssues(() => Effect.die("gh must not run"), { type: "github.issue", repo: "a/b/../c" }, cursor),
    )
    assert.match(error.message, /owner\/name/)
  })

  test("surfaces gh failures as PollError", async () => {
    const error = await runFailure(
      pollGithubIssues(
        () => Effect.fail({ message: "API rate limit exceeded" }),
        { type: "github.issue", repo: "a/b" },
        cursor,
      ),
    )
    assert.equal(error._tag, "PollError")
    assert.equal(error.message, "API rate limit exceeded")
  })
})

describe("pollLinearIssues", () => {
  const cursor = "2026-10-12T03:00:00.000Z"

  test("filters by team, state, label and createdAt, then advances the cursor", async () => {
    const filters: Array<LinearIssueFilter> = []
    const list = async (filter: LinearIssueFilter) => {
      filters.push(filter)
      // The server already filters, but a stale replica must not replay old issues.
      return [node("9", "2026-10-12T03:09:00Z"), node("7", "2026-10-12T03:07:00Z"), node("1", cursor)]
    }
    const result = await run(
      pollLinearIssues(list, { type: "linear.issue", teamKey: "ENG", stateName: "Todo", label: "bot" }, cursor),
    )

    assert.deepEqual(filters[0], {
      team: { key: { eq: "ENG" } },
      createdAt: { gt: new Date(cursor) },
      state: { name: { eqIgnoreCase: "Todo" } },
      labels: { some: { name: { eqIgnoreCase: "bot" } } },
    })
    assert.deepEqual(
      result.events.map((event) => event.key),
      ["linear:7", "linear:9"],
    )
    assert.equal(result.cursor, "2026-10-12T03:09:00.000Z")
  })

  test("omits optional filters", async () => {
    const filters: Array<LinearIssueFilter> = []
    await run(
      pollLinearIssues(
        async (filter) => {
          filters.push(filter)
          return []
        },
        { type: "linear.issue", teamKey: "ENG" },
        cursor,
      ),
    )
    assert.deepEqual(Object.keys(filters[0] ?? {}), ["team", "createdAt"])
  })

  test("turns SDK rejections into PollError", async () => {
    const error = await runFailure(
      pollLinearIssues(rejectUnauthenticated, { type: "linear.issue", teamKey: "ENG" }, cursor),
    )
    assert.equal(error.message, "Authentication required")
  })
})

describe("pollSlackMentions", () => {
  const cursor = "1791774000.000000"
  test("searches for the bot mention and returns newer messages, oldest first", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = []
    const body = {
      ok: true,
      messages: { matches: [match("1791774100.000200"), match("1791774050.000100"), match(cursor)] },
    }
    const result = await run(
      pollSlackMentions(
        fakeFetch(body, requests),
        "xoxp-1",
        { type: "slack.mention", botUserId: "U1", channel: "#general" },
        cursor,
      ),
    )

    assert.equal(requests[0]?.url.searchParams.get("query"), "<@U1> in:#general")
    assert.equal(requests[0]?.url.searchParams.get("sort"), "timestamp")
    assert.deepEqual(requests[0]?.init.headers, { Authorization: "Bearer xoxp-1" })
    assert.deepEqual(
      result.events.map((event) => event.key),
      ["slack:C1:1791774050.000100", "slack:C1:1791774100.000200"],
    )
    assert.equal(result.cursor, "1791774100.000200")
  })

  test("keeps the cursor when nothing is new", async () => {
    const body = { ok: true, messages: { matches: [match(cursor)] } }
    const result = await run(
      pollSlackMentions(fakeFetch(body), "t", { type: "slack.mention", botUserId: "U1" }, cursor),
    )
    assert.deepEqual(result, { events: [], cursor })
  })

  test("reports Slack API errors", async () => {
    const error = await runFailure(
      pollSlackMentions(
        fakeFetch({ ok: false, error: "not_allowed_token_type" }),
        "xoxb",
        { type: "slack.mention", botUserId: "U1" },
        cursor,
      ),
    )
    assert.equal(error.message, "Slack search.messages: not_allowed_token_type")
  })
})

describe("renderTemplate", () => {
  test("fills nested paths, blanks missing ones and does not escape HTML", () => {
    const payload = { issue: { title: "<b>Crash</b>", number: 12, labels: ["a"] } }
    assert.equal(
      renderTemplate("{{issue.title}} #{{ issue.number }} {{issue.labels}} [{{issue.missing.deep}}]", payload),
      '<b>Crash</b> #12 ["a"] []',
    )
  })
})

describe("slugifyBranch", () => {
  test("keeps path segments and strips unsafe characters", () => {
    assert.equal(slugifyBranch("kk/Issue 12: Fix the Thing!"), "kk/issue-12-fix-the-thing")
    assert.equal(slugifyBranch("kk//..bad../x.lock"), "kk/bad/x")
    assert.equal(slugifyBranch("修正"), "")
  })
})

describe("titleFromPrompt", () => {
  test("uses the first non-empty line", () => {
    assert.equal(titleFromPrompt("\n  New issue: crash \nmore", "fallback"), "New issue: crash")
    assert.equal(titleFromPrompt("  ", "fallback"), "fallback")
  })
})

describe("signatureMatches", () => {
  const body = new TextEncoder().encode('{"a":1}')
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

  test("accepts the HMAC of the raw body", () => {
    assert.equal(signatureMatches("s3cret", body, sign("s3cret")), true)
  })

  test("rejects a wrong secret, a missing header and a malformed header", () => {
    assert.equal(signatureMatches("s3cret", body, sign("other")), false)
    assert.equal(signatureMatches("s3cret", body, undefined), false)
    assert.equal(signatureMatches("s3cret", body, "sha256=abc"), false)
  })
})
