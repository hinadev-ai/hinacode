import { homedir } from "node:os"
import { dirname } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { ChecksStatus, GitHubAuth, PullRequest, PullRequestStatus, ReviewStatus } from "../../shared/domain.ts"
import type { GitHubRepository } from "../../shared/github.ts"
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
})
type RollupEntry = typeof RollupEntry.Type

export const PULL_REQUEST_FIELDS = "url,number,title,state,isDraft,reviewDecision,statusCheckRollup"

const PullRequestJson = Schema.fromJsonString(
  Schema.Struct({
    url: Schema.String,
    number: Schema.Number,
    title: Schema.String,
    state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
    isDraft: Schema.Boolean,
    reviewDecision: Schema.String,
    statusCheckRollup: Schema.Array(RollupEntry),
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
  }
}

const decodeAuthStatus = Schema.decodeUnknownEffect(AuthStatusJson)
const decodePullRequest = Schema.decodeUnknownEffect(PullRequestJson)

/** GitHub as the user's `gh` login sees it. Every call runs `gh` without prompts. */
export class GitHub extends Context.Service<
  GitHub,
  {
    readonly auth: Effect.Effect<GitHubAuth, CommandError | Schema.SchemaError>
    /** Runs `gh ...args` in `cwd` and returns stdout. */
    readonly run: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<string, GitHubError>
    readonly pullRequest: (url: string) => Effect.Effect<PullRequest, GitHubError | Schema.SchemaError>
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

  return GitHub.of({
    auth,
    run: gh,
    pullRequest: (url) => view(homedir(), url),
    branchPullRequest,
    createPullRequest,
    clone,
  })
})

export const layer = Layer.effect(GitHub, make)
