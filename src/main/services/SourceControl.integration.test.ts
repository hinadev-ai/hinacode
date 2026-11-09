import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { PullRequest } from "../../shared/domain.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import { GitHub } from "./GitHub.ts"
import * as SourceControlService from "./SourceControl.ts"
import { SourceControl } from "./SourceControl.ts"

const hasGlab = (() => {
  try {
    execFileSync("glab", ["version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const dirs: Array<string> = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const repoWithOrigin = (origin: string) => {
  const dir = mkdtempSync(join(tmpdir(), "kk-source-control-"))
  dirs.push(dir)
  execFileSync("git", ["init", "-q", dir])
  execFileSync("git", ["-C", dir, "remote", "add", "origin", origin])
  return dir
}

const githubAnswer = (url: string): PullRequest => ({
  url,
  number: 1,
  title: "from gh",
  status: "open",
  checks: null,
  review: null,
  mergeable: "unknown",
  author: "octocat",
  headRefName: "feature",
  baseRefName: "main",
  additions: 0,
  deletions: 0,
})

const gitHub = Layer.mock(GitHub, {
  pullRequest: (url) => Effect.succeed(githubAnswer(url)),
  branchPullRequest: (cwd) => Effect.succeed(githubAnswer(`gh:${cwd}`)),
})

const testLayer = SourceControlService.layer.pipe(
  Layer.provide(Layer.mergeAll(Git.layer, gitHub, Layer.succeed(Events, { publish: () => Effect.void }))),
  Layer.provide(NodeServices.layer),
)

describe("SourceControl", () => {
  layer(testLayer)((it) => {
    it.effect("sends GitHub pull request URLs to gh", () =>
      Effect.gen(function* () {
        const sourceControl = yield* SourceControl
        const read = yield* sourceControl.pullRequest("https://github.com/hinadev-ai/hinacode/pull/617")
        expect(read.title).toBe("from gh")
      }),
    )

    it.effect("rejects a URL that is neither", () =>
      Effect.gen(function* () {
        const sourceControl = yield* SourceControl
        const error = yield* Effect.flip(sourceControl.pullRequest("https://example.com/a/b/issues/1"))
        expect(error._tag).toBe("PullRequestUrlInvalidError")
      }),
    )

    it.effect("keeps github.com and hosts that are not GitLab on gh", () =>
      Effect.gen(function* () {
        const sourceControl = yield* SourceControl
        for (const origin of ["git@github.com:hinadev-ai/hinacode.git", "https://git.invalid/team/app.git"]) {
          const cwd = repoWithOrigin(origin)
          expect((yield* sourceControl.branchPullRequest(cwd, "feature"))?.url).toBe(`gh:${cwd}`)
        }
      }),
    )

    it.effect.skipIf(!hasGlab)("finds a branch's merge request on a gitlab.com remote", () =>
      Effect.gen(function* () {
        const sourceControl = yield* SourceControl
        const cwd = repoWithOrigin("git@gitlab.com:gitlab-org/cli.git")
        const found = yield* sourceControl.branchPullRequest(cwd, "jmc-stack-skill-reorder-infer-followup")
        expect(found?.url).toBe("https://gitlab.com/gitlab-org/cli/-/merge_requests/4335")
        expect(found?.status).toBe("merged")
      }),
    )
  })
})
