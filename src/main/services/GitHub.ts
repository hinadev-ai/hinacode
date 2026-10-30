import { homedir } from "node:os"
import { dirname } from "node:path"
import { parsePatch } from "@pulls.review/core/patch-parser"
import { Cache, Clock, Context, Effect, Exit, Layer, Schema, Semaphore, Struct } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type {
  CheckRun,
  CheckRunStatus,
  ChecksStatus,
  GitHubAuth,
  GitHubRateLimit,
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
import { PullRequestComment } from "../../shared/domain.ts"
import { type GitHubRepository, parseGitHubPullRequestUrl, parseGitHubRepository } from "../../shared/github.ts"
import { Events } from "./Events.ts"
import { CommandError, makeExec, REMOTE_GIT_ARGS, REMOTE_GIT_ENV, type RunOptions } from "./Git.ts"

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

export class GitHubApiError extends Schema.TaggedError<GitHubApiError>()("GitHubApiError", { detail: Schema.String }) {
  override get message(): string {
    return this.detail
  }
}

type GhError = GitHubCliMissingError | GitHubSignedOutError | GitHubRateLimitedError | CommandError

export type GitHubError = GhError | GitHubApiError

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  { url: Schema.String },
) {
  override get message(): string {
    return `${this.url} is not a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>)`
  }
}

// FIXME: GitHub's diff line limit counts context lines, so a diff can pass `diffTooLarge` and still hit it
export class PullRequestDiffTooLargeError extends Schema.TaggedError<PullRequestDiffTooLargeError>()(
  "PullRequestDiffTooLargeError",
  {},
) {
  override get message(): string {
    return "GitHub does not serve diffs over 20,000 lines or 300 files."
  }
}

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

export const parseAuthStatus = (json: typeof AuthStatusJson.Type): GitHubAuth => {
  const accounts = Object.values(json.hosts)
    .flat()
    .filter((account) => account.state === "success")
  const account = accounts.find((candidate) => candidate.active) ?? accounts[0]
  return account ? { type: "signedIn", host: account.host, login: account.login } : { type: "signedOut" }
}

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

const PullRequestDetailFields = Schema.Struct({
  ...PullRequestFields.fields,
  body: Schema.String,
  headRefOid: Schema.String,
  changedFiles: Schema.Number,
  comments: Schema.Array(PullRequestComment),
})
type PullRequestDetailFields = typeof PullRequestDetailFields.Type

// FIXME: `gh pr view` hides GitHub's rate limit headers, so this asks `gh api graphql` instead
const PULL_REQUEST_QUERY = `query PullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url number title state isDraft reviewDecision mergeable
      author { login }
      headRefName baseRefName headRefOid additions deletions changedFiles body
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        ... on CheckRun { __typename name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { __typename context state targetUrl }
      } } } } } }
      comments(last: 50) { nodes { ...Comment url } }
      reviews(last: 50) { nodes { ...Comment url } }
      reviewThreads(last: 50) { nodes { isResolved comments(first: 20) { nodes { ...Comment url path line } } } }
    }
  }
}

fragment Comment on Comment {
  id body createdAt viewerDidAuthor author { __typename login }
}`

const GraphQLCheck = Schema.Union([
  Schema.Struct({
    __typename: Schema.Literal("CheckRun"),
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    detailsUrl: Schema.NullOr(Schema.String),
    checkSuite: Schema.NullOr(
      Schema.Struct({
        workflowRun: Schema.NullOr(Schema.Struct({ workflow: Schema.Struct({ name: Schema.String }) })),
      }),
    ),
  }),
  Schema.Struct({
    __typename: Schema.Literal("StatusContext"),
    context: Schema.String,
    state: Schema.String,
    targetUrl: Schema.NullOr(Schema.String),
  }),
])

const GraphQLAuthor = Schema.NullOr(Schema.Struct({ login: Schema.String }))

const GraphQLComment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.String,
  viewerDidAuthor: Schema.Boolean,
  author: Schema.NullOr(Schema.Struct({ __typename: Schema.String, login: Schema.String })),
})

const GraphQLReviewComment = Schema.Struct({
  ...GraphQLComment.fields,
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
})

const GraphQLPullRequest = Schema.Struct({
  ...PullRequestDetailFields.mapFields(Struct.omit(["reviewDecision", "author", "statusCheckRollup", "comments"]))
    .fields,
  reviewDecision: Schema.NullOr(Schema.String),
  author: GraphQLAuthor,
  comments: Schema.Struct({ nodes: Schema.Array(GraphQLComment) }),
  reviews: Schema.Struct({ nodes: Schema.Array(GraphQLComment) }),
  reviewThreads: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        isResolved: Schema.Boolean,
        comments: Schema.Struct({ nodes: Schema.Array(GraphQLReviewComment) }),
      }),
    ),
  }),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({
          statusCheckRollup: Schema.NullOr(
            Schema.Struct({ contexts: Schema.Struct({ nodes: Schema.Array(GraphQLCheck) }) }),
          ),
        }),
      }),
    ),
  }),
})

const decodePullRequestResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ data: Schema.Struct({ repository: Schema.Struct({ pullRequest: GraphQLPullRequest }) }) }),
  ),
)

const toRollupEntry = (check: typeof GraphQLCheck.Type): RollupEntry => {
  if (check.__typename === "StatusContext") {
    return { context: check.context, state: check.state, ...(check.targetUrl ? { targetUrl: check.targetUrl } : {}) }
  }
  const workflowName = check.checkSuite?.workflowRun?.workflow.name
  return {
    name: check.name,
    status: check.status,
    ...(check.conclusion ? { conclusion: check.conclusion } : {}),
    ...(workflowName ? { workflowName } : {}),
    ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}),
  }
}

const toComment = (
  { id, body, createdAt, url, author, viewerDidAuthor }: typeof GraphQLComment.Type,
  location: PullRequestComment["location"] = null,
): PullRequestComment => ({
  id,
  author: author?.login ?? "ghost",
  authorKind: viewerDidAuthor ? "you" : author?.__typename === "Bot" ? "bot" : "human",
  body,
  createdAt,
  url,
  location,
})

const toComments = ({
  comments,
  reviews,
  reviewThreads,
}: Pick<typeof GraphQLPullRequest.Type, "comments" | "reviews" | "reviewThreads">) =>
  [
    ...comments.nodes.map((comment) => toComment(comment)),
    ...reviews.nodes.filter((review) => review.body.trim() !== "").map((review) => toComment(review)),
    ...reviewThreads.nodes
      .filter((thread) => !thread.isResolved)
      .flatMap((thread) =>
        thread.comments.nodes.map((comment) => toComment(comment, { path: comment.path, line: comment.line })),
      ),
  ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))

const fromGraphQL = ({
  commits,
  reviewDecision,
  author,
  comments,
  reviews,
  reviewThreads,
  ...fields
}: typeof GraphQLPullRequest.Type): PullRequestDetailFields => ({
  ...fields,
  reviewDecision: reviewDecision ?? "",
  author: author ?? { login: "ghost" },
  statusCheckRollup: (commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(toRollupEntry),
  comments: toComments({ comments, reviews, reviewThreads }),
})

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"])

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

export const toPullRequestDetail = (json: PullRequestDetailFields): PullRequestDetail => ({
  ...toPullRequest(json),
  body: json.body,
  baseRef: json.baseRefName,
  headRef: json.headRefName,
  head: json.headRefOid,
  changedFiles: json.changedFiles,
  comments: json.comments,
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

const RateLimitBucket = Schema.Struct({
  limit: Schema.Number,
  remaining: Schema.Number,
  used: Schema.Number,
  reset: Schema.Number,
})
const decodeRateLimit = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ resources: Schema.Struct({ core: RateLimitBucket, graphql: RateLimitBucket }) }),
  ),
)

const fromBucket = (resource: string, { limit, remaining, used, reset }: typeof RateLimitBucket.Type) => ({
  resource,
  limit,
  remaining,
  used,
  resetsAt: reset * 1000,
})

interface ApiResponse {
  readonly status: number
  readonly headers: ReadonlyMap<string, string>
  readonly body: string
}

export const parseApiResponse = (stdout: string): ApiResponse => {
  const blank = /\r?\n\r?\n/.exec(stdout)
  const head = blank ? stdout.slice(0, blank.index) : stdout
  const [statusLine = "", ...lines] = head.split(/\r?\n/)
  const headers = new Map(
    lines.map((line) => {
      const colon = line.indexOf(":")
      return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const
    }),
  )
  return {
    status: Number(statusLine.split(" ")[1]),
    headers,
    body: blank ? stdout.slice(blank.index + blank[0].length) : "",
  }
}

export const rateLimitOf = (headers: ReadonlyMap<string, string>): GitHubRateLimit | null => {
  const header = (name: string) => Number(headers.get(`x-ratelimit-${name}`) ?? Number.NaN)
  const [limit, remaining, used, reset] = [header("limit"), header("remaining"), header("used"), header("reset")]
  if (![limit, remaining, used, reset].every(Number.isFinite)) return null
  return { resource: headers.get("x-ratelimit-resource") ?? "", limit, remaining, used, resetsAt: reset * 1000 }
}

const LOW_BUDGET_SHARE = 0.2

type BudgetLevel = "ok" | "low" | "exhausted"

const budgetLevel = ({ limit, remaining }: GitHubRateLimit): BudgetLevel =>
  remaining === 0 ? "exhausted" : remaining < limit * LOW_BUDGET_SHARE ? "low" : "ok"

const ApiErrorBody = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.optionalKey(Schema.String), message: Schema.String })),
  ),
})
const decodeApiErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ApiErrorBody))

const decodeAuthStatus = Schema.decodeUnknownEffect(AuthStatusJson)
const decodePullRequest = Schema.decodeUnknownEffect(PullRequestJson)

const PullRequestHead = Schema.Struct({
  url: Schema.String,
  number: Schema.Int,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  isCrossRepository: Schema.Boolean,
})
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

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly auth: Effect.Effect<GitHubAuth, CommandError | GitHubRateLimitedError | Schema.SchemaError>
    readonly token: Effect.Effect<string, GitHubError>
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
    readonly merge: (url: string, method: MergeMethod) => Effect.Effect<void, GitHubError | PullRequestUrlInvalidError>
    readonly close: (url: string) => Effect.Effect<void, GitHubError | PullRequestUrlInvalidError>
    readonly comment: (url: string, body: string) => Effect.Effect<void, GitHubError | PullRequestUrlInvalidError>
    readonly branchPullRequest: (
      cwd: string,
      branch: string,
    ) => Effect.Effect<PullRequest | null, GitHubError | Schema.SchemaError>
    readonly pullRequestHead: (
      cwd: string,
      selector: string,
    ) => Effect.Effect<PullRequestHead, GitHubError | Schema.SchemaError>
    readonly openPullRequests: (
      cwd: string,
    ) => Effect.Effect<ReadonlyArray<OpenPullRequest>, GitHubError | Schema.SchemaError>
    readonly searchPullRequests: (
      repository: GitHubRepository,
      query: string,
    ) => Effect.Effect<ReadonlyArray<PullRequestMatch>, GitHubError | Schema.SchemaError>
    readonly createPullRequest: (
      cwd: string,
      branches: { readonly head: string; readonly base: string },
    ) => Effect.Effect<string, GitHubError>
    readonly clone: (repository: GitHubRepository, dest: string) => Effect.Effect<void, CommandError>
    readonly repository: (cwd: string) => Effect.Effect<GitHubRepository | null>
  }
>()("hinacode/GitHub") {}

const SIGNED_OUT_EXIT_CODE = 4

const RATE_LIMITED = /rate limit/i
const SECONDARY_PAUSE_MS = 60_000
const MAX_SECONDARY_PAUSE_MS = 15 * 60_000

const OPEN_PULL_REQUEST_TTL = "30 seconds"
const LOW_BUDGET_PULL_REQUEST_TTL = "5 minutes"
const FINISHED_PULL_REQUEST_TTL = "10 minutes"

const make = Effect.gen(function* () {
  const exec = makeExec(yield* ChildProcessSpawner.ChildProcessSpawner)
  const events = yield* Events

  const ghUnpaused = (cwd: string, args: ReadonlyArray<string>, options?: Pick<RunOptions, "okExitCodes">) =>
    exec("gh", args, cwd, { ...options, env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }).pipe(
      Effect.mapError((error): GhError => {
        if (error.exitCode === -1) return new GitHubCliMissingError()
        if (error.exitCode === SIGNED_OUT_EXIT_CODE) return new GitHubSignedOutError()
        return error
      }),
    )

  let pausedUntil = 0
  let secondaryHits = 0
  let graphqlBudget: BudgetLevel = "ok"
  let warned: { readonly level: Exclude<BudgetLevel, "ok">; readonly until: number } | null = null
  const pausing = Semaphore.makeUnsafe(1)

  const pauseFor = (now: number, retryAfterSeconds?: number) => {
    if (retryAfterSeconds !== undefined) {
      pausedUntil = Math.max(pausedUntil, now + retryAfterSeconds * 1000)
    } else {
      pausedUntil = Math.max(
        pausedUntil,
        now + Math.min(SECONDARY_PAUSE_MS * 2 ** secondaryHits, MAX_SECONDARY_PAUSE_MS),
      )
      secondaryHits += 1
    }
    return pausedUntil
  }

  const observe = (rateLimit: GitHubRateLimit) =>
    Effect.gen(function* () {
      const level = budgetLevel(rateLimit)
      if (rateLimit.resource === "graphql") graphqlBudget = level
      if (level === "exhausted") pausedUntil = Math.max(pausedUntil, rateLimit.resetsAt)
      if (level === "ok") return
      // FIXME: GitHub's regions disagree a little on `remaining`, so a budget at the line would warn on every read
      const now = yield* Clock.currentTimeMillis
      const repeat = warned !== null && now < warned.until && (warned.level === level || level === "low")
      if (repeat) return
      warned = { level, until: rateLimit.resetsAt }
      yield* events.publish({ type: "github.rateLimit", level, rateLimit })
    })

  const pause = Semaphore.withPermit(
    pausing,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      if (now < pausedUntil) return pausedUntil
      const limits = yield* ghUnpaused(homedir(), ["api", "rate_limit"]).pipe(
        Effect.flatMap(decodeRateLimit),
        Effect.option,
      )
      if (limits._tag === "Some") {
        yield* observe(fromBucket("core", limits.value.resources.core))
        yield* observe(fromBucket("graphql", limits.value.resources.graphql))
      }
      return now < pausedUntil ? pausedUntil : pauseFor(now)
    }),
  )

  const failIfPaused = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    now < pausedUntil ? Effect.fail(new GitHubRateLimitedError({ resetsAt: pausedUntil })) : Effect.void,
  )

  const gh = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, GhError> =>
    Effect.gen(function* () {
      yield* failIfPaused
      const stdout = yield* ghUnpaused(cwd, args).pipe(
        Effect.catchIf(
          (error) => error._tag === "CommandError" && RATE_LIMITED.test(error.stderr),
          () => Effect.flatMap(pause, (resetsAt) => Effect.fail(new GitHubRateLimitedError({ resetsAt }))),
        ),
      )
      secondaryHits = 0
      return stdout
    })

  const ghApi = (args: ReadonlyArray<string>): Effect.Effect<string, GitHubError> =>
    Effect.gen(function* () {
      yield* failIfPaused
      // FIXME: gh exits 1 for any error response; the status line and body say which
      const response = parseApiResponse(
        yield* ghUnpaused(homedir(), ["api", ...args, "--include"], { okExitCodes: [1] }),
      )
      const rateLimit = rateLimitOf(response.headers)
      if (rateLimit !== null) yield* observe(rateLimit)
      const error = decodeApiErrorBody(response.body)
      const errors = error._tag === "Some" ? (error.value.errors ?? []) : []
      const message = error._tag === "Some" ? (error.value.message ?? "") : ""
      const limited =
        response.status === 429 ||
        (response.status === 403 && (rateLimit?.remaining === 0 || RATE_LIMITED.test(message))) ||
        errors.some((entry) => entry.type === "RATE_LIMITED")
      if (limited) {
        const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN)
        const now = yield* Clock.currentTimeMillis
        const resetsAt =
          now < pausedUntil ? pausedUntil : pauseFor(now, Number.isFinite(retryAfter) ? retryAfter : undefined)
        return yield* new GitHubRateLimitedError({ resetsAt })
      }
      if (response.status >= 400 || errors.length > 0) {
        return yield* new GitHubApiError({
          detail: errors.map((entry) => entry.message).join("\n") || message || `HTTP ${response.status}`,
        })
      }
      secondaryHits = 0
      return response.body
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
    // FIXME: a full https URL keeps gh from switching to a configured ssh git_protocol
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

  // FIXME: gh acts on a local checkout of the repository when run inside one
  const ghByUrl = (raw: string, args: (url: string) => ReadonlyArray<string>) =>
    Effect.flatMap(requirePullRequestUrl(raw), (url) => gh(homedir(), args(url)))

  const lastRead = new Map<string, PullRequestDetailFields>()

  const fetchPullRequest = (url: string) => {
    const [owner = "", name = "", , number = ""] = new URL(url).pathname.slice(1).split("/")
    return ghApi([
      "graphql",
      "-f",
      `query=${PULL_REQUEST_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ]).pipe(
      Effect.flatMap(decodePullRequestResponse),
      Effect.map(({ data }) => fromGraphQL(data.repository.pullRequest)),
    )
  }

  const reads = yield* Cache.makeWith(
    (url: string) =>
      fetchPullRequest(url).pipe(
        Effect.tap((json) => Effect.sync(() => lastRead.set(url, json))),
        Effect.catchTag("GitHubRateLimitedError", (error) => {
          const last = lastRead.get(url)
          return last === undefined ? Effect.fail(error) : Effect.succeed(last)
        }),
      ),
    {
      capacity: 1000,
      timeToLive: (exit) => {
        if (Exit.isFailure(exit)) return 0
        if (exit.value.state !== "OPEN") return FINISHED_PULL_REQUEST_TTL
        return graphqlBudget === "ok" ? OPEN_PULL_REQUEST_TTL : LOW_BUDGET_PULL_REQUEST_TTL
      },
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
    comment: (raw, body) => ghWrite(raw, (url) => ["pr", "comment", url, "--body", body]),
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
