import assert from "node:assert/strict"
import { describe, test } from "node:test"
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
    assert.deepEqual(parseAuthStatus({ hosts: {} }), { type: "signedOut" })
  })

  test("prefers the active account over another verified one", () => {
    const hosts = { "github.com": [account({ active: false, login: "other" }), account({ login: "me" })] }
    assert.deepEqual(parseAuthStatus({ hosts }), { type: "signedIn", host: "github.com", login: "me" })
  })

  test("a login whose token failed to verify does not count", () => {
    assert.deepEqual(parseAuthStatus({ hosts: { "github.com": [account({ state: "error" })] } }), {
      type: "signedOut",
    })
  })
})

const run = (status: string, conclusion = "") => ({ status, conclusion })
const commitStatus = (state: string) => ({ state })

describe("summarizeChecks", () => {
  test("no checks is null, not passing", () => {
    assert.equal(summarizeChecks([]), null)
  })

  test("only skipped or neutral checks is null", () => {
    assert.equal(summarizeChecks([run("COMPLETED", "SKIPPED"), run("COMPLETED", "NEUTRAL")]), null)
  })

  test("a failure wins over a running check", () => {
    assert.equal(summarizeChecks([run("IN_PROGRESS"), run("COMPLETED", "FAILURE")]), "failing")
  })

  test("a running check wins over successes", () => {
    assert.equal(summarizeChecks([run("COMPLETED", "SUCCESS"), run("QUEUED")]), "pending")
  })

  test("commit statuses count like check runs", () => {
    assert.equal(summarizeChecks([commitStatus("SUCCESS"), run("COMPLETED", "SKIPPED")]), "passing")
    assert.equal(summarizeChecks([commitStatus("PENDING")]), "pending")
    assert.equal(summarizeChecks([commitStatus("ERROR")]), "failing")
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
    assert.equal(toPullRequest({ ...json, isDraft: true }).status, "draft")
    assert.equal(toPullRequest({ ...json, isDraft: true, state: "CLOSED" }).status, "closed")
  })

  test("maps the review decision and leaves an empty one null", () => {
    assert.equal(toPullRequest({ ...json, reviewDecision: "CHANGES_REQUESTED" }).review, "changesRequested")
    assert.equal(toPullRequest(json).review, null)
  })
})
