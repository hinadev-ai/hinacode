import { execFileSync } from "node:child_process"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Events } from "./Events.ts"
import { GitLab, layer } from "./GitLab.ts"

const noEvents = Layer.succeed(Events, { publish: () => Effect.void })

const hasGlab = (() => {
  try {
    execFileSync("glab", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const run = <A, E>(effect: Effect.Effect<A, E, GitLab>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer.pipe(Layer.provide(NodeServices.layer), Layer.provide(noEvents)))))

const MERGED = "https://gitlab.com/gitlab-org/cli/-/merge_requests/4335"

describe.skipIf(!hasGlab)("GitLab", () => {
  test("reads a public merged merge request", async () => {
    expect(await run(GitLab.use((gitlab) => gitlab.pullRequest(MERGED)))).toMatchObject({
      url: MERGED,
      number: 4335,
      status: "merged",
      checks: "passing",
      review: "approved",
      author: "jay_mccure",
      headRefName: "jmc-stack-skill-reorder-infer-followup",
      baseRefName: "main",
      additions: 31,
      deletions: 6,
      mergedAt: "2026-11-06T02:14:57.439Z",
    })
  })

  test("reads its detail, with one check per pipeline job", async () => {
    const detail = await run(GitLab.use((gitlab) => gitlab.pullRequestDetail(`${MERGED}/diffs`)))
    expect(detail).toMatchObject({
      url: MERGED,
      head: "0b85b1ab3883569b446d642f29468d03ecb3ffc4",
      baseRef: "main",
      changedFiles: 1,
    })
    expect(detail.body).toContain("glab stack reorder")
    expect(detail.checkRuns.find((check) => check.name === "build_test")).toMatchObject({ status: "passing" })
  })

  test("knows gitlab.com and github.com without probing", async () => {
    expect(await run(GitLab.use((gitlab) => gitlab.isGitLabHost("gitlab.com")))).toBe(true)
    expect(await run(GitLab.use((gitlab) => gitlab.isGitLabHost("github.com")))).toBe(false)
  })
})
