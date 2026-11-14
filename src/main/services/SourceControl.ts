import { Context, Effect, Layer, type Schema } from "effect"
import { type CodeHost, parsePullRequestUrl, parseRemote, type RemoteProject } from "../../shared/codeHost.ts"
import type { MergeMethod, PullRequest, PullRequestDetail } from "../../shared/domain.ts"
import { Git } from "./Git.ts"
import { GitHub, type GitHubError, PullRequestUrlInvalidError } from "./GitHub.ts"
import * as GitLabService from "./GitLab.ts"
import { GitLab, type GitLabError, type GitLabMergeMethodError } from "./GitLab.ts"

export type SourceControlError = GitHubError | GitLabError | PullRequestUrlInvalidError

export const requirePullRequestUrl = (raw: string): Effect.Effect<string, PullRequestUrlInvalidError> => {
  const parsed = parsePullRequestUrl(raw)
  return parsed === undefined ? Effect.fail(new PullRequestUrlInvalidError({ url: raw })) : Effect.succeed(parsed.url)
}

type Repository = { readonly host: "github" } | { readonly host: "gitlab"; readonly project: RemoteProject }

export class SourceControl extends Context.Service<
  SourceControl,
  {
    readonly installedFor: (url: string) => Effect.Effect<boolean>
    readonly pullRequest: (url: string) => Effect.Effect<PullRequest, SourceControlError | Schema.SchemaError>
    readonly pullRequestDetail: (
      url: string,
      options?: { readonly fresh?: boolean | undefined },
    ) => Effect.Effect<PullRequestDetail, SourceControlError | Schema.SchemaError>
    readonly merge: (
      url: string,
      method: MergeMethod,
    ) => Effect.Effect<void, SourceControlError | GitLabMergeMethodError>
    readonly close: (url: string) => Effect.Effect<void, SourceControlError>
    readonly comment: (url: string, body: string) => Effect.Effect<void, SourceControlError>
    readonly branchPullRequest: (
      cwd: string,
      branch: string,
    ) => Effect.Effect<PullRequest | null, SourceControlError | Schema.SchemaError>
    readonly createPullRequest: (
      cwd: string,
      branches: { readonly head: string; readonly base: string },
    ) => Effect.Effect<string, SourceControlError>
  }
>()("hinacode/SourceControl") {}

const hostOfUrl = (url: string): Effect.Effect<CodeHost, PullRequestUrlInvalidError> => {
  const parsed = parsePullRequestUrl(url)
  return parsed === undefined ? Effect.fail(new PullRequestUrlInvalidError({ url })) : Effect.succeed(parsed.host)
}

const byUrl = <A, GitHubE, GitLabE>(
  url: string,
  onGitHub: () => Effect.Effect<A, GitHubE>,
  onGitLab: () => Effect.Effect<A, GitLabE>,
): Effect.Effect<A, GitHubE | GitLabE | PullRequestUrlInvalidError> =>
  Effect.flatMap(hostOfUrl(url), (host): Effect.Effect<A, GitHubE | GitLabE> =>
    host === "gitlab" ? onGitLab() : onGitHub(),
  )

const make = Effect.gen(function* () {
  const git = yield* Git
  const github = yield* GitHub
  const gitlab = yield* GitLab

  const repository = (cwd: string): Effect.Effect<Repository> =>
    Effect.gen(function* () {
      const origin = yield* git.run(cwd, ["remote", "get-url", "origin"]).pipe(
        Effect.map((stdout) => parseRemote(stdout)),
        Effect.orElseSucceed(() => undefined),
      )
      if (origin === undefined || origin.hostname === "github.com") return { host: "github" }
      return (yield* gitlab.isGitLabHost(origin.hostname)) ? { host: "gitlab", project: origin } : { host: "github" }
    })

  return SourceControl.of({
    installedFor: (url) => {
      const host = parsePullRequestUrl(url)?.host
      if (host === undefined) return Effect.succeed(false)
      return host === "gitlab" ? gitlab.installed : github.installed
    },
    pullRequest: (url) =>
      byUrl(
        url,
        () => github.pullRequest(url),
        () => gitlab.pullRequest(url),
      ),
    pullRequestDetail: (url, options) =>
      byUrl(
        url,
        () => github.pullRequestDetail(url, options),
        () => gitlab.pullRequestDetail(url),
      ),
    merge: (url, method) =>
      byUrl(
        url,
        () => github.merge(url, method),
        () => gitlab.merge(url, method),
      ),
    close: (url) =>
      byUrl(
        url,
        () => github.close(url),
        () => gitlab.close(url),
      ),
    comment: (url, body) =>
      byUrl(
        url,
        () => github.comment(url, body),
        () => gitlab.comment(url, body),
      ),
    branchPullRequest: (cwd, branch) =>
      Effect.flatMap(
        repository(cwd),
        (repo): Effect.Effect<PullRequest | null, SourceControlError | Schema.SchemaError> =>
          repo.host === "gitlab"
            ? gitlab.branchPullRequest(repo.project, branch)
            : github.branchPullRequest(cwd, branch),
      ),
    createPullRequest: (cwd, branches) =>
      Effect.flatMap(repository(cwd), (repo): Effect.Effect<string, SourceControlError> =>
        repo.host === "gitlab"
          ? gitlab.createPullRequest(repo.project, cwd, branches)
          : github.createPullRequest(cwd, branches),
      ),
  })
})

export const layer = Layer.effect(SourceControl, make).pipe(Layer.provide(GitLabService.layer))
