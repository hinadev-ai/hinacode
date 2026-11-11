import { homedir } from "node:os"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type {
  CheckRun,
  CheckRunStatus,
  ChecksStatus,
  Mergeable,
  MergeMethod,
  PullRequest,
  PullRequestComment,
  PullRequestDetail,
  PullRequestStatus,
  ReviewStatus,
} from "../../shared/domain.ts"
import {
  type GitLabMergeRequest,
  gitLabMergeRequestUrl,
  parseGitLabMergeRequestUrl,
  type RemoteProject,
} from "../../shared/codeHost.ts"
import { findBinary } from "../agents/binary.ts"
import { Events } from "./Events.ts"
import { CommandError, COMMAND_NOT_FOUND_EXIT_CODE, LONG_TIMEOUT, makeExec, type RunOptions } from "./Git.ts"
import { parseApiResponse, PullRequestUrlInvalidError } from "./GitHub.ts"

export class GitLabCliMissingError extends Schema.TaggedError<GitLabCliMissingError>()("GitLabCliMissingError", {}) {
  override get message(): string {
    return "The GitLab CLI (glab) is not installed. Install it from https://gitlab.com/gitlab-org/cli and sign in with glab auth login."
  }
}

export class GitLabSignedOutError extends Schema.TaggedError<GitLabSignedOutError>()("GitLabSignedOutError", {
  hostname: Schema.String,
}) {
  override get message(): string {
    return `glab is not signed in to ${this.hostname}. Run glab auth login --hostname ${this.hostname} in a terminal.`
  }
}

export class GitLabApiError extends Schema.TaggedError<GitLabApiError>()("GitLabApiError", { detail: Schema.String }) {
  override get message(): string {
    return `GitLab refused the request: ${this.detail}`
  }
}

export class GitLabMergeMethodError extends Schema.TaggedError<GitLabMergeMethodError>()("GitLabMergeMethodError", {}) {
  override get message(): string {
    return "GitLab merges with the method the project is configured for. Choose Merge or Squash and merge."
  }
}

export type GitLabError = GitLabCliMissingError | GitLabSignedOutError | GitLabApiError | CommandError

export class GitLab extends Context.Service<
  GitLab,
  {
    readonly installed: Effect.Effect<boolean>
    readonly isGitLabHost: (hostname: string) => Effect.Effect<boolean>
    readonly pullRequest: (
      url: string,
    ) => Effect.Effect<PullRequest, GitLabError | PullRequestUrlInvalidError | Schema.SchemaError>
    readonly pullRequestDetail: (
      url: string,
    ) => Effect.Effect<PullRequestDetail, GitLabError | PullRequestUrlInvalidError | Schema.SchemaError>
    readonly merge: (
      url: string,
      method: MergeMethod,
    ) => Effect.Effect<void, GitLabError | GitLabMergeMethodError | PullRequestUrlInvalidError>
    readonly close: (url: string) => Effect.Effect<void, GitLabError | PullRequestUrlInvalidError>
    readonly comment: (url: string, body: string) => Effect.Effect<void, GitLabError | PullRequestUrlInvalidError>
    readonly branchPullRequest: (
      project: RemoteProject,
      branch: string,
    ) => Effect.Effect<PullRequest | null, GitLabError | Schema.SchemaError>
    readonly createPullRequest: (
      project: RemoteProject,
      cwd: string,
      branches: { readonly head: string; readonly base: string },
    ) => Effect.Effect<string, GitLabError>
  }
>()("hinacode/GitLab") {}

const Author = Schema.Struct({ username: Schema.String, bot: Schema.optionalKey(Schema.Boolean) })

export const MergeRequestJson = Schema.Struct({
  iid: Schema.Number,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  state: Schema.Literals(["opened", "closed", "locked", "merged"]),
  draft: Schema.Boolean,
  has_conflicts: Schema.Boolean,
  detailed_merge_status: Schema.String,
  sha: Schema.NullOr(Schema.String),
  source_branch: Schema.String,
  target_branch: Schema.String,
  merged_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  author: Author,
  head_pipeline: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.Number, status: Schema.String }))),
})
export type MergeRequestJson = typeof MergeRequestJson.Type

export const ApprovalsJson = Schema.Struct({
  approved: Schema.Boolean,
  approved_by: Schema.Array(Schema.Struct({ user: Schema.Struct({ username: Schema.String }) })),
})
export type ApprovalsJson = typeof ApprovalsJson.Type

export const DiffsJson = Schema.Array(Schema.Struct({ diff: Schema.String }))
export type DiffsJson = typeof DiffsJson.Type

export const JobsJson = Schema.Array(
  Schema.Struct({ name: Schema.String, status: Schema.String, allow_failure: Schema.Boolean, web_url: Schema.String }),
)
export type JobsJson = typeof JobsJson.Type

export const NotesJson = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    body: Schema.String,
    author: Author,
    created_at: Schema.String,
    system: Schema.Boolean,
    position: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          new_path: Schema.String,
          new_line: Schema.NullOr(Schema.Number),
          old_path: Schema.String,
          old_line: Schema.NullOr(Schema.Number),
        }),
      ),
    ),
  }),
)
export type NotesJson = typeof NotesJson.Type

const MergeRequestList = Schema.Array(Schema.Struct({ iid: Schema.Number }))
const User = Schema.Struct({ username: Schema.String })

const decodeJson = <S extends Schema.Top>(schema: S) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))
const decodeMergeRequest = decodeJson(MergeRequestJson)
const decodeApprovals = decodeJson(ApprovalsJson)
const decodeDiffs = decodeJson(DiffsJson)
const decodeJobs = decodeJson(JobsJson)
const decodeNotes = decodeJson(NotesJson)
const decodeMergeRequestList = decodeJson(MergeRequestList)
const decodeUser = decodeJson(User)

interface MergeRequestReads {
  readonly url: string
  readonly mergeRequest: MergeRequestJson
  readonly approvals: ApprovalsJson
  readonly diffs: DiffsJson
}

interface MergeRequestDetailReads extends MergeRequestReads {
  readonly changedFiles: number
  readonly jobs: JobsJson
  readonly notes: NotesJson
  readonly viewer: string | null
}

const mergeRequestStatus = ({ state, draft }: MergeRequestJson): PullRequestStatus => {
  if (state === "merged") return "merged"
  if (state === "opened") return draft ? "draft" : "open"
  return "closed"
}

const PASSING = new Set(["success"])
const FAILING = new Set(["failed", "canceled"])
const NOT_RUN = new Set(["skipped", "manual"])

export const pipelineChecks = (status: string | undefined): ChecksStatus | null => {
  if (status === undefined || NOT_RUN.has(status)) return null
  if (PASSING.has(status)) return "passing"
  if (FAILING.has(status)) return "failing"
  return "pending"
}

const reviewOf = ({ detailed_merge_status }: MergeRequestJson, approvals: ApprovalsJson): ReviewStatus | null => {
  if (detailed_merge_status === "requested_changes") return "changesRequested"
  if (approvals.approved && approvals.approved_by.length > 0) return "approved"
  if (detailed_merge_status === "not_approved") return "reviewRequired"
  return null
}

const STILL_CHECKING = new Set(["checking", "unchecked", "preparing"])

const mergeableOf = ({ has_conflicts, detailed_merge_status }: MergeRequestJson): Mergeable => {
  if (has_conflicts) return "conflicting"
  return STILL_CHECKING.has(detailed_merge_status) ? "unknown" : "mergeable"
}

export const diffStat = (diffs: DiffsJson) => {
  let additions = 0
  let deletions = 0
  for (const { diff } of diffs) {
    for (const line of diff.split("\n")) {
      if (line.startsWith("+")) additions += 1
      else if (line.startsWith("-")) deletions += 1
    }
  }
  return { additions, deletions }
}

export const toPullRequest = ({ url, mergeRequest, approvals, diffs }: MergeRequestReads): PullRequest => ({
  url,
  number: mergeRequest.iid,
  title: mergeRequest.title,
  status: mergeRequestStatus(mergeRequest),
  checks: pipelineChecks(mergeRequest.head_pipeline?.status),
  review: reviewOf(mergeRequest, approvals),
  mergeable: mergeableOf(mergeRequest),
  author: mergeRequest.author.username,
  headRefName: mergeRequest.source_branch,
  baseRefName: mergeRequest.target_branch,
  ...diffStat(diffs),
  mergedAt: mergeRequest.merged_at,
})

const jobStatus = ({ status, allow_failure }: JobsJson[number]): CheckRunStatus => {
  if (status === "failed" && allow_failure) return "skipped"
  return pipelineChecks(status) ?? "skipped"
}

const CHECK_RUN_ORDER: Record<CheckRunStatus, number> = { failing: 0, pending: 1, passing: 2, skipped: 3 }

export const toCheckRuns = (jobs: JobsJson): ReadonlyArray<CheckRun> =>
  jobs
    .map((job) => ({ name: job.name, status: jobStatus(job), url: job.web_url }))
    .toSorted((a, b) => CHECK_RUN_ORDER[a.status] - CHECK_RUN_ORDER[b.status])

const noteLocation = (position: NotesJson[number]["position"]): PullRequestComment["location"] => {
  if (!position) return null
  if (position.new_line === null && position.old_line !== null) {
    return { path: position.old_path, line: position.old_line, side: "LEFT" }
  }
  return { path: position.new_path, line: position.new_line, side: "RIGHT" }
}

export const toComments = (url: string, notes: NotesJson, viewer: string | null): ReadonlyArray<PullRequestComment> =>
  notes
    .filter((note) => !note.system)
    .map((note) => ({
      id: String(note.id),
      author: note.author.username,
      authorKind: note.author.bot ? "bot" : note.author.username === viewer ? "you" : "human",
      body: note.body,
      createdAt: note.created_at,
      url: `${url}#note_${note.id}`,
      location: noteLocation(note.position),
    }))

export const toPullRequestDetail = (reads: MergeRequestDetailReads): PullRequestDetail => ({
  ...toPullRequest(reads),
  body: reads.mergeRequest.description ?? "",
  baseRef: reads.mergeRequest.target_branch,
  headRef: reads.mergeRequest.source_branch,
  head: reads.mergeRequest.sha ?? "",
  checkRuns: toCheckRuns(reads.jobs),
  changedFiles: reads.changedFiles,
  comments: toComments(reads.url, reads.notes, reads.viewer),
  labels: [],
  assignees: [],
  reviewers: [],
})

const GLAB_ERROR = /^glab: (?:(.*\S)\s+\()?HTTP (\d+)\)?/m

export const gitLabErrorOf = (hostname: string, error: CommandError): GitLabError => {
  if (error.exitCode === COMMAND_NOT_FOUND_EXIT_CODE) return new GitLabCliMissingError()
  const http = GLAB_ERROR.exec(error.stderr)
  if (!http) return error
  const [, detail, status] = http
  if (status === "401") return new GitLabSignedOutError({ hostname })
  return new GitLabApiError({ detail: detail ?? `HTTP ${status}` })
}

export const mergeRequestUrlIn = (output: string): string | undefined => {
  const mergeRequest = output
    .split(/\s+/)
    .map(parseGitLabMergeRequestUrl)
    .find((parsed) => parsed !== undefined)
  return mergeRequest && gitLabMergeRequestUrl(mergeRequest)
}

const GLAB_TIMEOUT = "1 minute"
const PROBE_TIMEOUT = "10 seconds"

const projectApi = ({ path }: RemoteProject) => `projects/${encodeURIComponent(path)}`
const mergeRequestApi = (mergeRequest: GitLabMergeRequest) =>
  `${projectApi(mergeRequest)}/merge_requests/${mergeRequest.iid}`

const requireMergeRequest = (raw: string): Effect.Effect<GitLabMergeRequest, PullRequestUrlInvalidError> => {
  const mergeRequest = parseGitLabMergeRequestUrl(raw.trim())
  return mergeRequest ? Effect.succeed(mergeRequest) : Effect.fail(new PullRequestUrlInvalidError({ url: raw }))
}

const make = Effect.gen(function* () {
  const exec = makeExec(yield* ChildProcessSpawner.ChildProcessSpawner)
  const events = yield* Events

  const glab = (hostname: string, cwd: string, args: ReadonlyArray<string>, options?: Pick<RunOptions, "timeout">) =>
    exec("glab", args, cwd, { timeout: GLAB_TIMEOUT, ...options, env: { NO_COLOR: "1" } }).pipe(
      Effect.mapError((error) => gitLabErrorOf(hostname, error)),
    )

  const api = (hostname: string, args: ReadonlyArray<string>, options?: Pick<RunOptions, "timeout">) =>
    glab(hostname, homedir(), ["api", "--hostname", hostname, ...args], options)

  const hostAnswers = new Map<string, boolean>([
    ["gitlab.com", true],
    ["github.com", false],
  ])
  const isGitLabHost = (hostname: string) => {
    const known = hostAnswers.get(hostname)
    if (known !== undefined) return Effect.succeed(known)
    return api(hostname, ["version"], { timeout: PROBE_TIMEOUT }).pipe(
      Effect.as(true),
      Effect.catchTag("GitLabSignedOutError", () => Effect.succeed(true)),
      Effect.catchTag("GitLabApiError", () => Effect.succeed(false)),
      Effect.tap((answer) => Effect.sync(() => hostAnswers.set(hostname, answer))),
      Effect.orElseSucceed(() => false),
    )
  }

  const viewers = new Map<string, string>()
  const viewer = (hostname: string) => {
    const known = viewers.get(hostname)
    if (known !== undefined) return Effect.succeed(known)
    return api(hostname, ["user"]).pipe(
      Effect.flatMap(decodeUser),
      Effect.map((user) => user.username),
      Effect.tap((username) => Effect.sync(() => viewers.set(hostname, username))),
      Effect.orElseSucceed(() => null),
    )
  }

  const readMergeRequest = (mergeRequest: GitLabMergeRequest) =>
    api(mergeRequest.hostname, [mergeRequestApi(mergeRequest)]).pipe(Effect.flatMap(decodeMergeRequest))

  const readDiffs = (mergeRequest: GitLabMergeRequest) =>
    api(mergeRequest.hostname, ["--include", `${mergeRequestApi(mergeRequest)}/diffs?per_page=100`]).pipe(
      Effect.flatMap((stdout) => {
        const { headers, body } = parseApiResponse(stdout)
        return Effect.map(decodeDiffs(body), (diffs) => ({
          diffs,
          changedFiles: Number(headers.get("x-total")) || diffs.length,
        }))
      }),
    )

  const readSummary = (mergeRequest: GitLabMergeRequest) =>
    Effect.all(
      {
        mergeRequest: readMergeRequest(mergeRequest),
        approvals: api(mergeRequest.hostname, [`${mergeRequestApi(mergeRequest)}/approvals`]).pipe(
          Effect.flatMap(decodeApprovals),
        ),
        diffs: readDiffs(mergeRequest),
      },
      { concurrency: "unbounded" },
    )

  const pullRequestOf = (mergeRequest: GitLabMergeRequest) =>
    Effect.map(readSummary(mergeRequest), ({ diffs, ...reads }) =>
      toPullRequest({ ...reads, diffs: diffs.diffs, url: gitLabMergeRequestUrl(mergeRequest) }),
    )

  const readJobs = (hostname: string, project: RemoteProject, pipeline: MergeRequestJson["head_pipeline"]) =>
    pipeline
      ? api(hostname, [`${projectApi(project)}/pipelines/${pipeline.id}/jobs?per_page=100`]).pipe(
          Effect.flatMap(decodeJobs),
        )
      : Effect.succeed([])

  const readNotes = (mergeRequest: GitLabMergeRequest) =>
    api(mergeRequest.hostname, [`${mergeRequestApi(mergeRequest)}/notes?sort=asc&per_page=100`]).pipe(
      Effect.flatMap(decodeNotes),
      Effect.catchTag("GitLabSignedOutError", () => Effect.succeed([])),
    )

  const pullRequestDetail = (url: string) =>
    Effect.gen(function* () {
      const mergeRequest = yield* requireMergeRequest(url)
      const [summary, notes, signedIn] = yield* Effect.all(
        [readSummary(mergeRequest), readNotes(mergeRequest), viewer(mergeRequest.hostname)],
        { concurrency: "unbounded" },
      )
      const jobs = yield* readJobs(mergeRequest.hostname, mergeRequest, summary.mergeRequest.head_pipeline)
      return toPullRequestDetail({
        url: gitLabMergeRequestUrl(mergeRequest),
        mergeRequest: summary.mergeRequest,
        approvals: summary.approvals,
        diffs: summary.diffs.diffs,
        changedFiles: summary.diffs.changedFiles,
        jobs,
        notes,
        viewer: signedIn,
      })
    })

  const mutate = (url: string, args: (mergeRequest: GitLabMergeRequest) => ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const mergeRequest = yield* requireMergeRequest(url)
      yield* api(mergeRequest.hostname, args(mergeRequest))
      yield* events.publish({ type: "github.pullRequest", url: gitLabMergeRequestUrl(mergeRequest) })
    })

  return GitLab.of({
    installed: Effect.promise(() => findBinary("glab")).pipe(Effect.map((path) => path !== undefined)),
    isGitLabHost,
    pullRequest: (url) => Effect.flatMap(requireMergeRequest(url), pullRequestOf),
    pullRequestDetail,
    merge: (url, method) =>
      method === "rebase"
        ? Effect.fail(new GitLabMergeMethodError())
        : mutate(url, (mergeRequest) => [
            "-X",
            "PUT",
            `${mergeRequestApi(mergeRequest)}/merge`,
            ...(method === "squash" ? ["-f", "squash=true"] : []),
          ]),
    close: (url) =>
      mutate(url, (mergeRequest) => ["-X", "PUT", mergeRequestApi(mergeRequest), "-f", "state_event=close"]),
    comment: (url, body) =>
      mutate(url, (mergeRequest) => ["-X", "POST", `${mergeRequestApi(mergeRequest)}/notes`, "-f", `body=${body}`]),
    branchPullRequest: (project, branch) =>
      Effect.gen(function* () {
        const query = new URLSearchParams({
          source_branch: branch,
          state: "all",
          order_by: "created_at",
          sort: "desc",
          per_page: "1",
        })
        const [latest] = yield* api(project.hostname, [`${projectApi(project)}/merge_requests?${query}`]).pipe(
          Effect.flatMap(decodeMergeRequestList),
        )
        return latest ? yield* pullRequestOf({ ...project, iid: latest.iid }) : null
      }),
    createPullRequest: (project, cwd, { head, base }) =>
      Effect.gen(function* () {
        const output = yield* glab(
          project.hostname,
          cwd,
          ["mr", "create", "--source-branch", head, "--target-branch", base, "--fill", "--yes"],
          { timeout: LONG_TIMEOUT },
        )
        const url = mergeRequestUrlIn(output)
        if (url === undefined) {
          return yield* new GitLabApiError({ detail: `glab mr create printed no merge request URL: ${output.trim()}` })
        }
        return url
      }),
  })
})

export const layer = Layer.effect(GitLab, make)
