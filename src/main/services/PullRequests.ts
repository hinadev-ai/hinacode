import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { allWatchEventKinds, PullRequestLink, PullRequestWatch, type WatchEventKind } from "../../shared/domain.ts"
import { Events } from "./Events.ts"
import { nowIso } from "./clock.ts"
import { type NotFoundError, type PersistenceError, persistence } from "./errors.ts"
import { type CommandError, Git } from "./Git.ts"
import { GitHub, type GitHubError, type PullRequestUrlInvalidError, requirePullRequestUrl } from "./GitHub.ts"
import { parseGitHubPullRequestUrl } from "../../shared/github.ts"
import { Threads } from "./Threads.ts"
import { Worktrees } from "./Worktrees.ts"

export class NoBranchError extends Schema.TaggedError<NoBranchError>()("NoBranchError", { threadId: Schema.String }) {
  override get message(): string {
    return "This thread has no worktree branch to open a pull request from"
  }
}

const LinkRow = Schema.Struct({
  ...PullRequestLink.fields,
  watch: Schema.NullOr(Schema.fromJsonString(PullRequestWatch)),
})

export class PullRequests extends Context.Service<
  PullRequests,
  {
    readonly list: (threadId: string) => Effect.Effect<ReadonlyArray<PullRequestLink>, PersistenceError>
    readonly listAll: Effect.Effect<ReadonlyArray<PullRequestLink>, PersistenceError>
    readonly watched: Effect.Effect<ReadonlyArray<PullRequestLink>, PersistenceError>
    readonly find: (linkId: string) => Effect.Effect<PullRequestLink | null, PersistenceError>
    readonly link: (
      threadId: string,
      url: string,
    ) => Effect.Effect<string, PersistenceError | PullRequestUrlInvalidError>
    readonly unlink: (threadId: string, url: string) => Effect.Effect<void, PersistenceError>
    readonly watch: (
      threadId: string,
      url: string,
      events?: ReadonlyArray<WatchEventKind>,
    ) => Effect.Effect<PullRequestLink, PersistenceError | PullRequestUrlInvalidError>
    readonly unwatch: (threadId: string, url: string) => Effect.Effect<void, PersistenceError>
    readonly updateWatch: (
      linkId: string,
      generation: PullRequestWatch["generation"],
      watch: PullRequestWatch | null,
    ) => Effect.Effect<boolean, PersistenceError>
    readonly create: (
      threadId: string,
    ) => Effect.Effect<
      string,
      PersistenceError | NotFoundError | NoBranchError | CommandError | GitHubError | PullRequestUrlInvalidError
    >
  }
>()("hinacode/PullRequests") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* Events
  const threads = yield* Threads
  const worktrees = yield* Worktrees
  const git = yield* Git
  const github = yield* GitHub
  const encodeRow = Schema.encodeEffect(LinkRow)
  const encodeWatch = Schema.encodeEffect(Schema.NullOr(Schema.fromJsonString(PullRequestWatch)))

  const findByThread = SqlSchema.findAll({
    Request: Schema.String,
    Result: LinkRow,
    execute: (threadId) => sql`SELECT * FROM pull_request_link WHERE thread_id = ${threadId} ORDER BY created_at`,
  })
  const list = (threadId: string) => findByThread(threadId).pipe(Effect.mapError(persistence("pullRequests.list")))
  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: LinkRow,
    execute: () => sql`SELECT * FROM pull_request_link ORDER BY created_at, rowid`,
  })
  const findWatched = SqlSchema.findAll({
    Request: Schema.Void,
    Result: LinkRow,
    execute: () => sql`SELECT * FROM pull_request_link WHERE watch IS NOT NULL ORDER BY created_at, rowid`,
  })
  const findById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: LinkRow,
    execute: (linkId) => sql`SELECT * FROM pull_request_link WHERE id = ${linkId}`,
  })

  const find = (linkId: string) =>
    findById(linkId).pipe(
      Effect.mapError(persistence("pullRequests.find")),
      Effect.map((link) => (link._tag === "Some" ? link.value : null)),
    )

  const broadcast = (threadId: string) =>
    Effect.flatMap(list(threadId), (links) => events.publish({ type: "thread.pullRequests", threadId, links }))

  const link = (threadId: string, raw: string) =>
    Effect.gen(function* () {
      const url = yield* requirePullRequestUrl(raw)
      const row: PullRequestLink = { id: randomUUID(), threadId, url, createdAt: yield* nowIso, watch: null }
      const encoded = yield* encodeRow(row).pipe(Effect.mapError(persistence("pullRequests.link")))
      yield* sql`INSERT INTO pull_request_link ${sql.insert(encoded)} ON CONFLICT (thread_id, url) DO NOTHING`.pipe(
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

  const setWatch = (current: PullRequestLink, watch: PullRequestWatch | null) =>
    Effect.gen(function* () {
      const encoded = yield* encodeRow({ ...current, watch }).pipe(Effect.mapError(persistence("pullRequests.watch")))
      yield* sql`UPDATE pull_request_link SET watch = ${encoded.watch} WHERE id = ${current.id}`.pipe(
        Effect.mapError(persistence("pullRequests.watch")),
      )
      yield* broadcast(current.threadId)
      return { ...current, watch }
    })

  const byUrl = (threadId: string, url: string) =>
    Effect.map(list(threadId), (links) => links.find((candidate) => candidate.url === url) ?? null)

  const watch = (threadId: string, raw: string, requested: ReadonlyArray<WatchEventKind> = []) =>
    Effect.gen(function* () {
      const url = yield* requirePullRequestUrl(raw)
      yield* link(threadId, url)
      const current = yield* byUrl(threadId, url)
      if (current === null) {
        return yield* Effect.die(new Error(`pull request link for ${url} vanished right after linking`))
      }
      const kinds = [...new Set(requested)]
      return yield* setWatch(current, {
        generation: randomUUID(),
        events: kinds.length > 0 ? kinds : [...allWatchEventKinds],
        snapshot: null,
        wakes: 0,
        failures: 0,
        lastPolledAt: null,
        lastWokeAt: null,
      })
    })

  const unwatch = (threadId: string, raw: string) =>
    Effect.gen(function* () {
      const url = parseGitHubPullRequestUrl(raw.trim()) ?? raw
      const current = yield* byUrl(threadId, url)
      if (current === null || current.watch === null) return
      yield* setWatch(current, null)
    })

  const updateWatch = (linkId: string, generation: PullRequestWatch["generation"], next: PullRequestWatch | null) =>
    Effect.gen(function* () {
      const encoded = yield* encodeWatch(next).pipe(Effect.mapError(persistence("pullRequests.updateWatch")))
      const updated = yield* sql<{ readonly threadId: string }>`
        UPDATE pull_request_link SET watch = ${encoded}
        WHERE id = ${linkId} AND json_extract(watch, '$.generation') = ${generation}
        RETURNING thread_id
      `.pipe(Effect.mapError(persistence("pullRequests.updateWatch")))
      const row = updated[0]
      if (row === undefined) return false
      yield* broadcast(row.threadId)
      return true
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

  return PullRequests.of({
    list,
    listAll: findAll(undefined).pipe(Effect.mapError(persistence("pullRequests.listAll"))),
    watched: findWatched(undefined).pipe(Effect.mapError(persistence("pullRequests.watched"))),
    find,
    link,
    unlink,
    watch,
    unwatch,
    updateWatch,
    create,
  })
})

export const layer = Layer.effect(PullRequests, make)
