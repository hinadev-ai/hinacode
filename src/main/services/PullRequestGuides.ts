import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type EffortLevel, query } from "@anthropic-ai/claude-agent-sdk"
import { analysisJsonSchema, buildAnalysisPrompt, buildCliAgentSystemPrompt } from "@pulls.review/core/llm"
import { parsePatch } from "@pulls.review/core/patch-parser"
import type { DiffsPayload } from "@pulls.review/core/types"
import { Cause, Context, Duration, Effect, FiberMap, Layer, Schedule, Schema, Semaphore } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import {
  GuideGroup,
  type Locale,
  PullRequestGuide,
  type PullRequestDetail,
  type PullRequestGuideJob,
  type PullRequestGuideState,
} from "../../shared/domain.ts"
import { CLAUDE_EFFORT_LEVELS } from "../../shared/agent.ts"
import { diffTooLarge } from "../../shared/pullRequestGuide.ts"
import { installedBinary } from "../agents/binary.ts"
import { ClientSettings } from "./ClientSettings.ts"
import { nowIso } from "./clock.ts"
import { type PersistenceError, persistence } from "./errors.ts"
import { Events } from "./Events.ts"
import { GitHub, type GitHubError, type PullRequestUrlInvalidError, requirePullRequestUrl } from "./GitHub.ts"
import { PullRequests } from "./PullRequests.ts"
import { Settings } from "./Settings.ts"
import { Threads } from "./Threads.ts"

const SWEEP_INTERVAL = "3 minutes"
const ANALYSIS_TIMEOUT = Duration.minutes(10)
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"]

const Answer = Schema.Struct({ overallSummary: Schema.String, groups: Schema.Array(GuideGroup) })

const GuideRow = Schema.Struct({ url: Schema.String, guide: Schema.fromJsonString(PullRequestGuide) })

export class PullRequestGuides extends Context.Service<
  PullRequestGuides,
  {
    readonly get: (url: string) => Effect.Effect<PullRequestGuideState, PersistenceError | PullRequestUrlInvalidError>
    readonly ensure: (detail: PullRequestDetail, options?: { readonly retry?: boolean }) => Effect.Effect<void>
    readonly retry: (url: string) => Effect.Effect<void, GitHubError | PullRequestUrlInvalidError | Schema.SchemaError>
    readonly sweep: Effect.Effect<void>
  }
>()("hinacode/PullRequestGuides") {}

const pullRequestRef = (url: string): DiffsPayload["ref"] => {
  const [, owner = "", repo = "", number = ""] = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url) ?? []
  return { kind: "github-pr", owner, repo, number }
}

const analyze = (
  detail: PullRequestDetail,
  diff: string,
  options: { readonly model: string; readonly effort: string; readonly locale: Locale },
) =>
  Effect.gen(function* () {
    const pathToClaudeCodeExecutable = yield* installedBinary("claude", "claude")
    const files = yield* Effect.promise(() => parsePatch(diff))
    const payload: DiffsPayload = {
      ref: pullRequestRef(detail.url),
      title: detail.title,
      label: `#${detail.number}`,
      description: detail.body,
      url: detail.url,
      files,
    }
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "hinacode-guide-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    )
    const patchPath = join(dir, "pull-request.diff")
    yield* Effect.promise(() => writeFile(patchPath, diff))
    const output = yield* Effect.tryPromise({
      try: async (signal) => {
        const abortController = new AbortController()
        signal.addEventListener("abort", () => abortController.abort())
        const stream = query({
          prompt: buildAnalysisPrompt(payload, options.locale),
          options: {
            pathToClaudeCodeExecutable,
            cwd: dir,
            model: options.model,
            effort: CLAUDE_EFFORT_LEVELS.includes(options.effort) ? (options.effort as EffortLevel) : undefined,
            systemPrompt: buildCliAgentSystemPrompt({ patchPath, repository: false }),
            tools: READ_ONLY_TOOLS,
            allowedTools: READ_ONLY_TOOLS,
            permissionMode: "dontAsk",
            settingSources: [],
            persistSession: false,
            outputFormat: { type: "json_schema", schema: analysisJsonSchema() as Record<string, unknown> },
            abortController,
          },
        })
        for await (const message of stream) {
          if (message.type !== "result") continue
          if (message.subtype !== "success") throw new Error(message.errors.join("\n") || message.subtype)
          return message.structured_output
        }
        throw new Error("Claude Code ended without a result")
      },
      catch: (cause) => new Error(cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.timeout(ANALYSIS_TIMEOUT))
    const answer = yield* Schema.decodeUnknownEffect(Answer)(output)
    return {
      head: detail.head,
      model: options.model,
      generatedAt: yield* nowIso,
      summary: answer.overallSummary,
      groups: answer.groups,
    } satisfies PullRequestGuide
  }).pipe(Effect.scoped)

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const github = yield* GitHub
  const settings = yield* Settings
  const clientSettings = yield* ClientSettings
  const pullRequests = yield* PullRequests
  const threads = yield* Threads
  const events = yield* Events
  const encodeRow = Schema.encodeEffect(GuideRow)

  const jobs = new Map<string, PullRequestGuideJob>()
  const latestWriterPerUrl = yield* FiberMap.make<string>()
  const oneAnalysisAtATime = Semaphore.makeUnsafe(1)
  const oneStartAtATime = Semaphore.makeUnsafe(1)
  const mergedOrClosed = new Set<string>()

  const findGuide = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: GuideRow,
    execute: (url) => sql`SELECT url, guide FROM pull_request_guide WHERE url = ${url}`,
  })
  const stored = (url: string) =>
    findGuide(url).pipe(
      Effect.mapError(persistence("pullRequestGuides.get")),
      Effect.map((row) => (row._tag === "Some" ? row.value.guide : null)),
    )

  const state = (url: string) =>
    Effect.map(stored(url), (guide): PullRequestGuideState => ({ guide, job: jobs.get(url) ?? null }))

  const publish = (url: string) =>
    state(url).pipe(
      Effect.flatMap((current) => events.publish({ type: "pullRequest.guide", url, state: current })),
      Effect.catchCause((cause) => Effect.logWarning("pull request guide push failed", url, cause)),
    )

  const endJobUnlessSuperseded = (url: string, head: string, next: PullRequestGuideJob | null) =>
    Effect.sync(() => {
      if (jobs.get(url)?.head !== head) return
      if (next === null) jobs.delete(url)
      else jobs.set(url, next)
    })

  const save = (url: string, guide: PullRequestGuide) =>
    Effect.flatMap(
      encodeRow({ url, guide }),
      (row) => sql`INSERT OR REPLACE INTO pull_request_guide ${sql.insert(row)}`,
    ).pipe(Effect.mapError(persistence("pullRequestGuides.save")))

  const write = (detail: PullRequestDetail) =>
    Effect.gen(function* () {
      const diff = yield* github.pullRequestDiff(detail.url)
      const { pullRequestGuide } = yield* settings.get
      const { locale } = yield* clientSettings.get
      const guide = yield* analyze(detail, diff, { ...pullRequestGuide, locale })
      yield* save(detail.url, guide)
      yield* endJobUnlessSuperseded(detail.url, detail.head, null)
    }).pipe(
      oneAnalysisAtATime.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logWarning("pull request guide failed", detail.url, cause).pipe(
          Effect.andThen(
            endJobUnlessSuperseded(detail.url, detail.head, {
              status: "failed",
              head: detail.head,
              message: failureMessage(cause),
            }),
          ),
        ),
      ),
      Effect.ensuring(publish(detail.url)),
    )

  const ensure = (detail: PullRequestDetail, { retry = false }: { readonly retry?: boolean } = {}) =>
    Effect.gen(function* () {
      if (detail.status === "merged" || detail.status === "closed") {
        mergedOrClosed.add(detail.url)
        return
      }
      if (diffTooLarge(detail)) return
      const job = jobs.get(detail.url)
      if (job?.head === detail.head && (job.status === "running" || !retry)) return
      if ((yield* stored(detail.url))?.head === detail.head) return
      jobs.set(detail.url, { status: "running", head: detail.head })
      yield* FiberMap.run(latestWriterPerUrl, detail.url, write(detail))
      yield* publish(detail.url)
    }).pipe(
      oneStartAtATime.withPermits(1),
      Effect.catchCause((cause) => Effect.logWarning("pull request guide not started", detail.url, cause)),
    )

  const retry = (url: string) =>
    Effect.flatMap(github.pullRequestDetail(url), (detail) => ensure(detail, { retry: true }))

  const sweep = Effect.gen(function* () {
    const live = new Set(
      (yield* threads.list).filter((thread) => thread.status !== "archived").map((thread) => thread.id),
    )
    const urls = new Set(
      (yield* pullRequests.listAll)
        .filter((link) => live.has(link.threadId) && !mergedOrClosed.has(link.url))
        .map((link) => link.url),
    )
    yield* Effect.forEach(
      urls,
      (url) =>
        github.pullRequestDetail(url).pipe(
          Effect.flatMap((detail) => ensure(detail)),
          Effect.catchCause((cause) => Effect.logWarning("pull request guide sweep skipped", url, cause)),
        ),
      { concurrency: 2, discard: true },
    )
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("pull request guide sweep failed", cause)))

  yield* Effect.schedule(sweep, Schedule.spaced(SWEEP_INTERVAL)).pipe(Effect.forkScoped)

  return PullRequestGuides.of({
    get: (raw) => Effect.flatMap(requirePullRequestUrl(raw), state),
    ensure,
    retry,
    sweep,
  })
})

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

export const layer = Layer.effect(PullRequestGuides, make)

export const idleLayer = Layer.succeed(
  PullRequestGuides,
  PullRequestGuides.of({
    get: () => Effect.succeed({ guide: null, job: null }),
    ensure: () => Effect.void,
    retry: () => Effect.void,
    sweep: Effect.void,
  }),
)
