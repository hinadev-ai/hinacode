import { describe, expect, test } from "@effect/vitest"
import { parseAuthStatus, summarizeChecks, toPullRequest } from "./GitHub.ts"

const account = (overrides: Partial<{ state: string; active: boolean; login: string }>) => ({
  state: "success",
  active: true,
  host: "github.com",
  login: "octocat",
  ...overrides,
})

describe("parseAuthStatus", () => {
  test("no hosts means signed out", () => {
    expect(parseAuthStatus({ hosts: {} })).toStrictEqual({ type: "signedOut" })
  })

  test("prefers the active account over another verified one", () => {
    const hosts = { "github.com": [account({ active: false, login: "other" }), account({ login: "me" })] }
    expect(parseAuthStatus({ hosts })).toStrictEqual({ type: "signedIn", host: "github.com", login: "me" })
  })

  test("a login whose token failed to verify does not count", () => {
    expect(parseAuthStatus({ hosts: { "github.com": [account({ state: "error" })] } })).toStrictEqual({
      type: "signedOut",
    })
  })
})

const run = (status: string, conclusion = "") => ({ status, conclusion })
const commitStatus = (state: string) => ({ state })

describe("summarizeChecks", () => {
  test("no checks is null, not passing", () => {
    expect(summarizeChecks([])).toBe(null)
  })

  test("only skipped or neutral checks is null", () => {
    expect(summarizeChecks([run("COMPLETED", "SKIPPED"), run("COMPLETED", "NEUTRAL")])).toBe(null)
  })

  test("a failure wins over a running check", () => {
    expect(summarizeChecks([run("IN_PROGRESS"), run("COMPLETED", "FAILURE")])).toBe("failing")
  })

  test("a running check wins over successes", () => {
    expect(summarizeChecks([run("COMPLETED", "SUCCESS"), run("QUEUED")])).toBe("pending")
  })

  test("commit statuses count like check runs", () => {
    expect(summarizeChecks([commitStatus("SUCCESS"), run("COMPLETED", "SKIPPED")])).toBe("passing")
    expect(summarizeChecks([commitStatus("PENDING")])).toBe("pending")
    expect(summarizeChecks([commitStatus("ERROR")])).toBe("failing")
  })
})

const json = {
  url: "https://github.com/a/b/pull/1",
  number: 1,
  title: "Fix",
  state: "OPEN" as const,
  isDraft: false,
  reviewDecision: "",
  statusCheckRollup: [],
}

describe("toPullRequest", () => {
  test("an open draft is a draft, a closed draft is closed", () => {
    expect(toPullRequest({ ...json, isDraft: true }).status).toBe("draft")
    expect(toPullRequest({ ...json, isDraft: true, state: "CLOSED" }).status).toBe("closed")
  })

  test("maps the review decision and leaves an empty one null", () => {
    expect(toPullRequest({ ...json, reviewDecision: "CHANGES_REQUESTED" }).review).toBe("changesRequested")
    expect(toPullRequest(json).review).toBe(null)
  })
})
