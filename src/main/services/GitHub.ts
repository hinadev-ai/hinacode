import { homedir } from "node:os"
import { dirname } from "node:path"
import { parsePatch } from "@pulls.review/core/patch-parser"
import { Cache, Clock, Context, Effect, Exit, Layer, Schema, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type {
  CheckRun,
  CheckRunStatus,
  ChecksStatus,
  GitHubAuth,
  Mergeable,
  MergeMethod,
  PullRequest,
  PullRequestDetail,
  PullRequestFile,
  PullRequestStatus,
  ReviewStatus,
  OpenPullRequest,
  PullRequestMatch,
} from "../../shared/domain.ts"
import { type GitHubRepository, parseGitHubPullRequestUrl, parseGitHubRepository } from "../../shared/github.ts"
import { CommandError, makeExec, REMOTE_GIT_ARGS, REMOTE_GIT_ENV } from "./Git.ts"

export class GitHubCliMissingError extends Schema.TaggedError<GitHubCliMissingError>()("GitHubCliMissingError", {}) {
  override get message(): string {
    return "The GitHub CLI (gh) is not installed. Install it from https://cli.github.com and sign in with gh auth login."
  }
}

export class GitHubSignedOutError extends Schema.TaggedError<GitHubSignedOutError>()("GitHubSignedOutError", {}) {
  override get message(): string {
    return "gh is not signed in. Run gh auth login in a terminal."
  }
}

export class GitHubRateLimitedError extends Schema.TaggedError<GitHubRateLimitedError>()("GitHubRateLimitedError", {
  resetsAt: Schema.Number,
}) {
  override get message(): string {
    return `GitHub's API rate limit is used up. HinaCode asks again after ${new Date(this.resetsAt).toISOString()}.`
  }
}

export type GitHubError = GitHubCliMissingError | GitHubSignedOutError | GitHubRateLimitedError | CommandError

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  { url: Schema.String },
) {
  override get message(): string {
    return `${this.url} is not a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>)`
  }
}

/** GitHub's lines limit counts context lines too, so a diff can pass `diffTooLarge` and still get this. */
export class PullRequestDiffTooLargeError extends Schema.TaggedError<PullRequestDiffTooLargeError>()(
  "PullRequestDiffTooLargeError",
  {},
) {
  override get message(): string {
    return "GitHub does not serve diffs over 20,000 lines or 300 files."
  }
}

/** The canonical pull request URL, safe to pass to `gh` as an argument: it can never be read as a flag. */
export const requirePullRequestUrl = (raw: string): Effect.Effect<string, PullRequestUrlInvalidError> => {
  const url = parseGitHubPullRequestUrl(raw.trim())
  return url === undefined ? Effect.fail(new PullRequestUrlInvalidError({ url: raw })) : Effect.succeed(url)
}

const AuthStatusJson = Schema.fromJsonString(
  Schema.Struct({
    hosts: Schema.Record(
      Schema.String,
      Schema.Array(
        Schema.Struct({ state: Schema.String, active: Schema.Boolean, host: Schema.String, login: Schema.String }),
      ),
    ),
  }),
)

/** Parses `gh auth status --json hosts`, preferring the active account of a host. */
export const parseAuthStatus = (json: typeof AuthStatusJson.Type): GitHubAuth => {
  const accounts = Object.values(json.hosts)
    .flat()
    .filter((account) => account.state === "success")
  const account = accounts.find((candidate) => candidate.active) ?? accounts[0]
  return account ? { type: "signedIn", host: account.host, login: account.login } : { type: "signedOut" }
}

/** A `statusCheckRollup` entry: a check run carries `status` and `conclusion`, a commit status carries `state`. */
const RollupEntry = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  workflowName: Schema.optionalKey(Schema.String),
  detailsUrl: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.String),
  targetUrl: Schema.optionalKey(Schema.String),
})
type RollupEntry = typeof RollupEntry.Type

export const PULL_REQUEST_FIELDS =
  "url,number,title,state,isDraft,reviewDecision,statusCheckRollup,mergeable,author,headRefName,baseRefName,additions,deletions"

const PullRequestFields = Schema.Struct({
  url: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  reviewDecision: Schema.String,
  statusCheckRollup: Schema.Array(RollupEntry),
  mergeable: Schema.String,
  author: Schema.Struct({ login: Schema.String }),
  headRefName: Schema.String,
  baseRefName: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
})
const PullRequestJson = Schema.fromJsonString(PullRequestFields)

const PULL_REQUEST_DETAIL_FIELDS = `${PULL_REQUEST_FIELDS},body,headRefOid,changedFiles`

const PullRequestDetailJson = Schema.fromJsonString(
  Schema.Struct({
    ...PullRequestFields.fields,
    body: Schema.String,
    headRefOid: Schema.String,
    changedFiles: Schema.Number,
  }),
)

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"])

/** Neutral, skipped and stale checks say nothing about the change, so they count as no check. */
const checkOutcome = (entry: RollupEntry): ChecksStatus | null => {
  if (entry.status !== undefined && entry.status !== "COMPLETED") return "pending"
  const result = entry.conclusion || entry.state || ""
  if (FAILED.has(result)) return "failing"
  if (result === "PENDING" || result === "EXPECTED") return "pending"
  if (result === "SUCCESS") return "passing"
  return null
}

export const summarizeChecks = (rollup: ReadonlyArray<RollupEntry>): ChecksStatus | null => {
  const outcomes = new Set(rollup.map(checkOutcome))
  if (outcomes.has("failing")) return "failing"
  if (outcomes.has("pending")) return "pending"
  if (outcomes.has("passing")) return "passing"
  return null
}

const reviewStatus: Record<string, ReviewStatus> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changesRequested",
  REVIEW_REQUIRED: "reviewRequired",
}

const pullRequestStatus = (state: typeof PullRequestFields.Type.state, isDraft: boolean): PullRequestStatus =>
  state === "OPEN" ? (isDraft ? "draft" : "open") : state === "MERGED" ? "merged" : "closed"

const mergeable: Record<string, Mergeable> = { MERGEABLE: "mergeable", CONFLICTING: "conflicting" }

export const toPullRequest = (json: typeof PullRequestJson.Type): PullRequest => {
  const status = pullRequestStatus(json.state, json.isDraft)
  return {
    url: json.url,
    number: json.number,
    title: json.title,
    status,
    checks: summarizeChecks(json.statusCheckRollup),
    review: reviewStatus[json.reviewDecision] ?? null,
    mergeable: mergeable[json.mergeable] ?? "unknown",
    author: json.author.login,
    headRefName: json.headRefName,
    baseRefName: json.baseRefName,
    additions: json.additions,
    deletions: json.deletions,
  }
}

const CHECK_RUN_ORDER: Record<CheckRunStatus, number> = { failing: 0, pending: 1, passing: 2, skipped: 3 }

const toCheckRun = (entry: RollupEntry): CheckRun => {
  const { name, workflowName } = entry
  return {
    name:
      name === undefined
        ? (entry.context ?? "")
        : workflowName && workflowName !== name
          ? `${workflowName} / ${name}`
          : name,
    status: checkOutcome(entry) ?? "skipped",
    url: entry.detailsUrl || entry.targetUrl || null,
  }
}

export const toPullRequestDetail = (json: typeof PullRequestDetailJson.Type): PullRequestDetail => ({
  ...toPullRequest(json),
  body: json.body,
  baseRef: json.baseRefName,
  headRef: json.headRefName,
  head: json.headRefOid,
  changedFiles: json.changedFiles,
  checkRuns: json.statusCheckRollup
    .map(toCheckRun)
    .toSorted((a, b) => CHECK_RUN_ORDER[a.status] - CHECK_RUN_ORDER[b.status]),
})

export const pullRequestFiles = (diff: string): Effect.Effect<ReadonlyArray<PullRequestFile>> =>
  Effect.forEach(
    diff.split(/^(?=diff --git )/m).filter((section) => section.startsWith("diff --git ")),
    (patch) =>
      Effect.promise(() => parsePatch(patch)).pipe(
        Effect.map(([file]) =>
          file === undefined
            ? []
            : [
                {
                  path: file.path,
                  previousPath: file.previousPath ?? null,
                  status: file.status,
                  additions: file.additions,
                  deletions: file.deletions,
                  binary: file.isBinary,
                  patch,
                },
              ],
        ),
      ),
  ).pipe(Effect.map((files) => files.flat()))

const RateLimitBucket = Schema.Struct({ remaining: Schema.Number, reset: Schema.Number })
/** `gh api rate_limit`, which GitHub does not count against the primary limit. */
const decodeRateLimit = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ resources: Schema.Struct({ core: RateLimitBucket, graphql: RateLimitBucket }) }),
  ),
)

const decodeAuthStatus = Schema.decodeUnknownEffect(AuthStatusJson)
const decodePullRequest = Schema.decodeUnknownEffect(PullRequestJson)
const decodePullRequestDetail = Schema.decodeUnknownEffect(PullRequestDetailJson)

const PullRequestHead = Schema.Struct({
  url: Schema.String,
  number: Schema.Int,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  isCrossRepository: Schema.Boolean,
})
/** What checking out a pull request needs: where its head branch lives and what it merges into. */
export type PullRequestHead = typeof PullRequestHead.Type
const decodePullRequestHead = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequestHead))

const decodeOpenPullRequests = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        title: Schema.String,
        headRefName: Schema.String,
        isDraft: Schema.Boolean,
        author: Schema.Struct({ login: Schema.String }),
      }),
    ),
  ),
)

const decodePullRequestMatches = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        title: Schema.String,
        state: PullRequestFields.fields.state,
        isDraft: Schema.Boolean,
        author: Schema.Struct({ login: Schema.String }),
      }),
    ),
  ),
)

/** GitHub as the user's `gh` login sees it. Every call runs `gh` without prompts. */
export class GitHub extends Context.Service<
  GitHub,
  {
    readonly auth: Effect.Effect<GitHubAuth, CommandError | GitHubRateLimitedError | Schema.SchemaError>
    /** The signed-in account's token for github.com. Stays in main: never log it or send it to the renderer. */
    readonly token: Effect.Effect<string, GitHubError>
    /** Runs `gh ...args` in `cwd` and returns stdout. */
    readonly run: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<string, GitHubError>
    readonly pullRequest: (
      url: string,
    ) => Effect.Effect<PullRequest, GitHubError | PullRequestUrlInvalidError | Schema.SchemaError>
    readonly pullRequestDetail: (
      url: string,
    ) => Effect.Effect<PullRequestDetail, GitHubError | PullRequestUrlInvalidError | Schema.SchemaError>
    readonly pullRequestDiff: (
      url: string,
    ) => Effect.Effect<string, GitHubError | PullRequestUrlInvalidError | PullRequestDiffTooLargeError>
    /** Never deletes the branch: it is usually checked out in a local worktree. */
    readonly merge: (url: string, method: MergeMethod) => Effect.Effect<void, GitHubError | PullRequestUrlInvalidError>
    readonly close: (url: string) => Effect.Effect<void, GitHubError | PullRequestUrlInvalidError>
    /** The newest pull request whose head is `branch` in the repository at `cwd`, or null when there is none. */
    readonly branchPullRequest: (
      cwd: string,
      branch: string,
    ) => Effect.Effect<PullRequest | null, GitHubError | Schema.SchemaError>
    /** The pull request `selector` (a number or URL, see `parsePullRequestSelector`) names in the repository at `cwd`. */
    readonly pullRequestHead: (
      cwd: string,
      selector: string,
    ) => Effect.Effect<PullRequestHead, GitHubError | Schema.SchemaError>
    /** Open pull requests of the repository at `cwd`, newest first. */
    readonly openPullRequests: (
      cwd: string,
    ) => Effect.Effect<ReadonlyArray<OpenPullRequest>, GitHubError | Schema.SchemaError>
    /** Pull requests of `repository` in any state that match `query`, best match first; the newest for "". */
    readonly searchPullRequests: (
      repository: GitHubRepository,
      query: string,
    ) => Effect.Effect<ReadonlyArray<PullRequestMatch>, GitHubError | Schema.SchemaError>
    /** Opens a pull request from the pushed `head` branch, titled and described from its commits. Returns its URL. */
    readonly createPullRequest: (
      cwd: string,
      branches: { readonly head: string; readonly base: string },
    ) => Effect.Effect<string, GitHubError>
    /**
     * Clones `repository` into `dest`, whose parent must exist. Uses `gh`, so private repositories and the
     * user's preferred protocol work; without a signed-in `gh` it falls back to `git` over https.
     */
    readonly clone: (repository: GitHubRepository, dest: string) => Effect.Effect<void, CommandError>
    /** The GitHub repository `origin` points at in the checkout at `cwd`, or null when it has none. Never fails. */
    readonly repository: (cwd: string) => Effect.Effect<GitHubRepository | null>
  }
>()("hinacode/GitHub") {}

// gh exits with 4 when a command needs authentication.
const SIGNED_OUT_EXIT_CODE = 4

// gh passes GitHub's own wording through: "API rate limit exceeded", "secondary rate limit".
const RATE_LIMITED = /rate limit/i
// GitHub asks for at least a minute after a secondary limit, then exponentially longer while it keeps refusing.
const SECONDARY_PAUSE_MS = 60_000
const MAX_SECONDARY_PAUSE_MS = 15 * 60_000

const OPEN_PULL_REQUEST_TTL = "30 seconds"
const FINISHED_PULL_REQUEST_TTL = "10 minutes"

const make = Effect.gen(function* () {
  const exec = makeExec(yield* ChildProcessSpawner.ChildProcessSpawner)

  const ghUnpaused = (cwd: string, args: ReadonlyArray<string>) =>
    exec("gh", args, cwd, { env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }).pipe(
      Effect.mapError((error): GitHubError => {
        if (error.exitCode === -1) return new GitHubCliMissingError()
        if (error.exitCode === SIGNED_OUT_EXIT_CODE) return new GitHubSignedOutError()
        return error
      }),
    )

  // Every gh call shares one GitHub budget, so a rate limit pauses all of them, not only the command that hit it.
  let pausedUntil = 0
  let secondaryHits = 0
  const pausing = Semaphore.makeUnsafe(1)

  const pause = Semaphore.withPermit(
    pausing,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      if (now < pausedUntil) return pausedUntil
      const limits = yield* ghUnpaused(homedir(), ["api", "rate_limit"]).pipe(
        Effect.flatMap(decodeRateLimit),
        Effect.option,
      )
      const usedUp =
        limits._tag === "Some"
          ? [limits.value.resources.core, limits.value.resources.graphql].filter((bucket) => bucket.remaining === 0)
          : []
      if (usedUp.length > 0) {
        pausedUntil = Math.max(...usedUp.map((bucket) => bucket.reset * 1000))
      } else {
        pausedUntil = now + Math.min(SECONDARY_PAUSE_MS * 2 ** secondaryHits, MAX_SECONDARY_PAUSE_MS)
        secondaryHits += 1
      }
      return pausedUntil
    }),
  )

  const gh = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, GitHubError> =>
    Effect.gen(function* () {
      if ((yield* Clock.currentTimeMillis) < pausedUntil) {
        return yield* new GitHubRateLimitedError({ resetsAt: pausedUntil })
      }
      const stdout = yield* ghUnpaused(cwd, args).pipe(
        Effect.catchIf(
          (error) => error._tag === "CommandError" && RATE_LIMITED.test(error.stderr),
          () => Effect.flatMap(pause, (resetsAt) => Effect.fail(new GitHubRateLimitedError({ resetsAt }))),
        ),
      )
      secondaryHits = 0
      return stdout
    })

  const auth = gh(homedir(), ["auth", "status", "--json", "hosts"]).pipe(
    Effect.flatMap(decodeAuthStatus),
    Effect.map(parseAuthStatus),
    Effect.catchTags({
      GitHubCliMissingError: () => Effect.succeed<GitHubAuth>({ type: "missing" }),
      GitHubSignedOutError: () => Effect.succeed<GitHubAuth>({ type: "signedOut" }),
    }),
  )

  const view = (cwd: string, selector: string) =>
    gh(cwd, ["pr", "view", selector, "--json", PULL_REQUEST_FIELDS]).pipe(
      Effect.flatMap(decodePullRequest),
      Effect.map(toPullRequest),
    )

  const branchPullRequest = (cwd: string, branch: string) =>
    view(cwd, branch).pipe(
      Effect.catchIf(
        (error) => error._tag === "CommandError" && error.stderr.includes("no pull requests found"),
        () => Effect.succeed(null),
      ),
    )

  const createPullRequest = (cwd: string, { head, base }: { head: string; base: string }) =>
    gh(cwd, ["pr", "create", "--head", head, "--base", base, "--fill"]).pipe(
      Effect.map((stdout) => stdout.trim().split("\n").at(-1) ?? ""),
    )

  const clone = ({ owner, name }: GitHubRepository, dest: string) => {
    // A full https URL keeps gh from switching to its configured git_protocol, which may be ssh on a
    // machine that has no ssh key for GitHub.
    const url = `https://github.com/${owner}/${name}.git`
    const gitClone = () => exec("git", [...REMOTE_GIT_ARGS, "clone", url, dest], dirname(dest), { env: REMOTE_GIT_ENV })
    return gh(dirname(dest), ["repo", "clone", url, dest]).pipe(
      Effect.catchTags({
        GitHubCliMissingError: gitClone,
        GitHubSignedOutError: gitClone,
        GitHubRateLimitedError: gitClone,
      }),
      Effect.asVoid,
    )
  }

  // Run from the home directory so gh acts on the URL alone, never on a local checkout of the repository.
  const ghByUrl = (raw: string, args: (url: string) => ReadonlyArray<string>) =>
    Effect.flatMap(requirePullRequestUrl(raw), (url) => gh(homedir(), args(url)))

  // The last answer per pull request, served while GitHub is rate limited instead of an error.
  const lastRead = new Map<string, typeof PullRequestDetailJson.Type>()

  // Shared by every window, device and background sweep asking about the same pull request.
  const reads = yield* Cache.makeWith(
    (url: string) =>
      gh(homedir(), ["pr", "view", url, "--json", PULL_REQUEST_DETAIL_FIELDS]).pipe(
        Effect.flatMap(decodePullRequestDetail),
        Effect.tap((json) => Effect.sync(() => lastRead.set(url, json))),
        Effect.catchTag("GitHubRateLimitedError", (error) => {
          const last = lastRead.get(url)
          return last === undefined ? Effect.fail(error) : Effect.succeed(last)
        }),
      ),
    {
      capacity: 1000,
      timeToLive: (exit) =>
        Exit.isFailure(exit) ? 0 : exit.value.state === "OPEN" ? OPEN_PULL_REQUEST_TTL : FINISHED_PULL_REQUEST_TTL,
    },
  )

  const read = (raw: string) => Effect.flatMap(requirePullRequestUrl(raw), (url) => Cache.get(reads, url))

  const ghWrite = (raw: string, args: (url: string) => ReadonlyArray<string>) =>
    Effect.flatMap(requirePullRequestUrl(raw), (url) =>
      gh(homedir(), args(url)).pipe(Effect.andThen(Cache.invalidate(reads, url)), Effect.asVoid),
    )

  const repository = (cwd: string) =>
    exec("git", ["-C", cwd, "remote", "get-url", "origin"], cwd).pipe(
      Effect.map(parseGitHubRepository),
      Effect.orElseSucceed(() => null),
    )

  return GitHub.of({
    auth,
    token: ghUnpaused(homedir(), ["auth", "token", "--hostname", "github.com"]).pipe(
      Effect.map((stdout) => stdout.trim()),
    ),
    run: gh,
    pullRequest: (raw) => Effect.map(read(raw), toPullRequest),
    pullRequestDetail: (raw) => Effect.map(read(raw), toPullRequestDetail),
    pullRequestDiff: (raw) =>
      ghByUrl(raw, (url) => ["pr", "diff", url, "--color=never"]).pipe(
        Effect.catchIf(
          (error) => error._tag === "CommandError" && error.stderr.includes("too_large"),
          () => Effect.fail(new PullRequestDiffTooLargeError()),
        ),
      ),
    merge: (raw, method) => ghWrite(raw, (url) => ["pr", "merge", url, `--${method}`]),
    close: (raw) => ghWrite(raw, (url) => ["pr", "close", url]),
    branchPullRequest,
    pullRequestHead: (cwd, selector) =>
      gh(cwd, ["pr", "view", selector, "--json", "url,number,headRefName,baseRefName,isCrossRepository"]).pipe(
        Effect.flatMap(decodePullRequestHead),
      ),
    openPullRequests: (cwd) =>
      gh(cwd, [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "50",
        "--json",
        "number,title,headRefName,isDraft,author",
      ]).pipe(
        Effect.flatMap(decodeOpenPullRequests),
        Effect.map((list) => list.map(({ author, ...pullRequest }) => ({ ...pullRequest, author: author.login }))),
      ),
    searchPullRequests: ({ owner, name }, query) =>
      gh(homedir(), [
        "pr",
        "list",
        "--repo",
        `${owner}/${name}`,
        "--state",
        "all",
        "--limit",
        "20",
        ...(query === "" ? [] : [`--search=${query}`]),
        "--json",
        "number,title,state,isDraft,author",
      ]).pipe(
        Effect.flatMap(decodePullRequestMatches),
        Effect.map((list) =>
          list.map(({ number, title, state, isDraft, author }) => ({
            number,
            title,
            status: pullRequestStatus(state, isDraft),
            author: author.login,
          })),
        ),
      ),
    createPullRequest,
    clone,
    repository,
  })
})

export const layer = Layer.effect(GitHub, make)
