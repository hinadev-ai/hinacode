import { homedir } from "node:os"
import { dirname } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
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
  PullRequestStatus,
  ReviewStatus,
} from "../../shared/domain.ts"
import { type GitHubRepository, parseGitHubRepository } from "../../shared/github.ts"
import { CommandError, makeExec } from "./Git.ts"

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

export type GitHubError = GitHubCliMissingError | GitHubSignedOutError | CommandError

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  { url: Schema.String },
) {
  override get message(): string {
    return `${this.url} is not a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>)`
  }
}

/** Canonical `https://github.com/<owner>/<repo>/pull/<n>`, dropping sub-pages like `/files` and any query or hash. */
export const parseGitHubPullRequestUrl = (raw: string): string | undefined => {
  if (!URL.canParse(raw)) return undefined
  const url = new URL(raw)
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com"))
    return undefined
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/.*)?$/.exec(url.pathname)
  if (!match) return undefined
  const [, owner, repo, number] = match
  return `https://github.com/${owner}/${repo}/pull/${number}`
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
  "url,number,title,state,isDraft,reviewDecision,statusCheckRollup,author,headRefName,baseRefName,additions,deletions"

const PullRequestFields = Schema.Struct({
  url: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  reviewDecision: Schema.String,
  statusCheckRollup: Schema.Array(RollupEntry),
  author: Schema.Struct({ login: Schema.String }),
  headRefName: Schema.String,
  baseRefName: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
})
const PullRequestJson = Schema.fromJsonString(PullRequestFields)

const PULL_REQUEST_DETAIL_FIELDS = `${PULL_REQUEST_FIELDS},body,mergeable`

const PullRequestDetailJson = Schema.fromJsonString(
  Schema.Struct({
    ...PullRequestFields.fields,
    body: Schema.String,
    mergeable: Schema.String,
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

export const toPullRequest = (json: typeof PullRequestJson.Type): PullRequest => {
  const status: PullRequestStatus =
    json.state === "OPEN" ? (json.isDraft ? "draft" : "open") : json.state === "MERGED" ? "merged" : "closed"
  return {
    url: json.url,
    number: json.number,
    title: json.title,
    status,
    checks: summarizeChecks(json.statusCheckRollup),
    review: reviewStatus[json.reviewDecision] ?? null,
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

const mergeable: Record<string, Mergeable> = { MERGEABLE: "mergeable", CONFLICTING: "conflicting" }

export const toPullRequestDetail = (json: typeof PullRequestDetailJson.Type): PullRequestDetail => ({
  ...toPullRequest(json),
  body: json.body,
  baseRef: json.baseRefName,
  headRef: json.headRefName,
  mergeable: mergeable[json.mergeable] ?? "unknown",
  checkRuns: json.statusCheckRollup
    .map(toCheckRun)
    .toSorted((a, b) => CHECK_RUN_ORDER[a.status] - CHECK_RUN_ORDER[b.status]),
})

const decodeAuthStatus = Schema.decodeUnknownEffect(AuthStatusJson)
const decodePullRequest = Schema.decodeUnknownEffect(PullRequestJson)
const decodePullRequestDetail = Schema.decodeUnknownEffect(PullRequestDetailJson)

/** GitHub as the user's `gh` login sees it. Every call runs `gh` without prompts. */
export class GitHub extends Context.Service<
  GitHub,
  {
    readonly auth: Effect.Effect<GitHubAuth, CommandError | Schema.SchemaError>
    /** Runs `gh ...args` in `cwd` and returns stdout. */
    readonly run: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<string, GitHubError>
    readonly pullRequest: (
      url: string,
    ) => Effect.Effect<PullRequest, GitHubError | PullRequestUrlInvalidError | Schema.SchemaError>
    readonly pullRequestDetail: (
      url: string,
    ) => Effect.Effect<PullRequestDetail, GitHubError | PullRequestUrlInvalidError | Schema.SchemaError>
    /** Never deletes the branch: it is usually checked out in a local worktree. */
    readonly merge: (url: string, method: MergeMethod) => Effect.Effect<void, GitHubError | PullRequestUrlInvalidError>
    readonly close: (url: string) => Effect.Effect<void, GitHubError | PullRequestUrlInvalidError>
    /** The newest pull request whose head is `branch` in the repository at `cwd`, or null when there is none. */
    readonly branchPullRequest: (
      cwd: string,
      branch: string,
    ) => Effect.Effect<PullRequest | null, GitHubError | Schema.SchemaError>
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
>()("kkcode/GitHub") {}

// gh exits with 4 when a command needs authentication.
const SIGNED_OUT_EXIT_CODE = 4

const make = Effect.gen(function* () {
  const exec = makeExec(yield* ChildProcessSpawner.ChildProcessSpawner)

  const gh = (cwd: string, args: ReadonlyArray<string>) =>
    exec("gh", args, cwd, { env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }).pipe(
      Effect.mapError((error): GitHubError => {
        if (error.exitCode === -1) return new GitHubCliMissingError()
        if (error.exitCode === SIGNED_OUT_EXIT_CODE) return new GitHubSignedOutError()
        return error
      }),
    )

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
    // Without a terminal git would wait forever on a credential prompt; fail fast instead.
    const gitClone = () =>
      exec("git", ["clone", `https://github.com/${owner}/${name}.git`, dest], dirname(dest), {
        env: { GIT_TERMINAL_PROMPT: "0" },
      })
    return gh(dirname(dest), ["repo", "clone", `${owner}/${name}`, dest]).pipe(
      Effect.catchTags({ GitHubCliMissingError: gitClone, GitHubSignedOutError: gitClone }),
      Effect.asVoid,
    )
  }

  // Run from the home directory so gh acts on the URL alone, never on a local checkout of the repository.
  const ghByUrl = (raw: string, args: (url: string) => ReadonlyArray<string>) =>
    Effect.flatMap(requirePullRequestUrl(raw), (url) => gh(homedir(), args(url)))

  const repository = (cwd: string) =>
    exec("git", ["-C", cwd, "remote", "get-url", "origin"], cwd).pipe(
      Effect.map(parseGitHubRepository),
      Effect.orElseSucceed(() => null),
    )

  return GitHub.of({
    auth,
    run: gh,
    pullRequest: (raw) => Effect.flatMap(requirePullRequestUrl(raw), (url) => view(homedir(), url)),
    pullRequestDetail: (raw) =>
      ghByUrl(raw, (url) => ["pr", "view", url, "--json", PULL_REQUEST_DETAIL_FIELDS]).pipe(
        Effect.flatMap(decodePullRequestDetail),
        Effect.map(toPullRequestDetail),
      ),
    merge: (raw, method) => ghByUrl(raw, (url) => ["pr", "merge", url, `--${method}`]).pipe(Effect.asVoid),
    close: (raw) => ghByUrl(raw, (url) => ["pr", "close", url]).pipe(Effect.asVoid),
    branchPullRequest,
    createPullRequest,
    clone,
    repository,
  })
})

export const layer = Layer.effect(GitHub, make)
