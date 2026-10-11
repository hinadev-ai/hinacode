import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { PullRequestLink } from "../../shared/domain.ts"
import { Events } from "./Events.ts"
import { nowIso } from "./clock.ts"
import { type NotFoundError, type PersistenceError, persistence } from "./errors.ts"
import { type CommandError, Git } from "./Git.ts"
import { GitHub, type GitHubError } from "./GitHub.ts"
import { Threads } from "./Threads.ts"
import { Worktrees } from "./Worktrees.ts"

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  { url: Schema.String },
) {
  override get message(): string {
    return `${this.url} is not a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>)`
  }
}

/** Only a thread working in a ready worktree has a branch of its own to open a pull request from. */
export class NoBranchError extends Schema.TaggedError<NoBranchError>()("NoBranchError", { threadId: Schema.String }) {
  override get message(): string {
    return "This thread has no worktree branch to open a pull request from"
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

/** Pull requests an agent registered for a thread. Every change is pushed as `thread.pullRequests`. */
export class PullRequests extends Context.Service<
  PullRequests,
  {
    readonly list: (threadId: string) => Effect.Effect<ReadonlyArray<PullRequestLink>, PersistenceError>
    /** Returns the canonical URL. Linking the same pull request twice is a no-op. */
    readonly link: (
      threadId: string,
      url: string,
    ) => Effect.Effect<string, PersistenceError | PullRequestUrlInvalidError>
    readonly unlink: (threadId: string, url: string) => Effect.Effect<void, PersistenceError>
    /** Pushes the thread's worktree branch, opens a pull request against its base ref, and links it. */
    readonly create: (
      threadId: string,
    ) => Effect.Effect<
      string,
      PersistenceError | NotFoundError | NoBranchError | CommandError | GitHubError | PullRequestUrlInvalidError
    >
  }
>()("kkcode/PullRequests") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* Events
  const threads = yield* Threads
  const worktrees = yield* Worktrees
  const git = yield* Git
  const github = yield* GitHub

  const findByThread = SqlSchema.findAll({
    Request: Schema.String,
    Result: PullRequestLink,
    execute: (threadId) => sql`SELECT * FROM pull_request_link WHERE thread_id = ${threadId} ORDER BY created_at`,
  })
  const list = (threadId: string) => findByThread(threadId).pipe(Effect.mapError(persistence("pullRequests.list")))

  const broadcast = (threadId: string) =>
    Effect.flatMap(list(threadId), (links) => events.publish({ type: "thread.pullRequests", threadId, links }))

  const link = (threadId: string, raw: string) =>
    Effect.gen(function* () {
      const url = parseGitHubPullRequestUrl(raw.trim())
      if (url === undefined) return yield* new PullRequestUrlInvalidError({ url: raw })
      const row: PullRequestLink = { id: randomUUID(), threadId, url, createdAt: yield* nowIso }
      yield* sql`INSERT INTO pull_request_link ${sql.insert(row)} ON CONFLICT (thread_id, url) DO NOTHING`.pipe(
        Effect.mapError(persistence("pullRequests.link")),
      )
      yield* broadcast(threadId)
      return url
    })

  const unlink = (threadId: string, raw: string) =>
    Effect.gen(function* () {
      const url = parseGitHubPullRequestUrl(raw.trim()) ?? raw
      yield* sql`DELETE FROM pull_request_link WHERE thread_id = ${threadId} AND url = ${url}`.pipe(
        Effect.mapError(persistence("pullRequests.unlink")),
      )
      yield* broadcast(threadId)
    })

  const create = (threadId: string) =>
    Effect.gen(function* () {
      const { worktreeId } = yield* threads.get(threadId)
      if (worktreeId === null) return yield* new NoBranchError({ threadId })
      const worktree = yield* worktrees.get(worktreeId)
      if (worktree.status !== "ready") return yield* new NoBranchError({ threadId })
      yield* git.run(worktree.path, ["push", "--set-upstream", "origin", worktree.branch])
      const url = yield* github.createPullRequest(worktree.path, {
        head: worktree.branch,
        base: worktree.baseRef.replace(/^origin\//, ""),
      })
      return yield* link(threadId, url)
    })

  return PullRequests.of({ list, link, unlink, create })
})

export const layer = Layer.effect(PullRequests, make)
