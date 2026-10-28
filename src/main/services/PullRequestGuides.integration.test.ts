import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { afterAll, describe, expect, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { vi } from "vitest"
import type { PushEvent } from "../../shared/contract.ts"
import type { PullRequestDetail, PullRequestGuideState, PullRequestStatus } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import * as ClientSettings from "./ClientSettings.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import { GitHub } from "./GitHub.ts"
import * as Projects from "./Projects.ts"
import { layer as guidesLayer, PullRequestGuides } from "./PullRequestGuides.ts"
import { PullRequests, layer as pullRequestsLayer } from "./PullRequests.ts"
import { Settings, layer as settingsLayer } from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { Threads, layer as threadsLayer } from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"

interface Query {
  readonly prompt: string
  readonly options: Options
}

const queries: Array<Query> = []
let answer: (query: Query) => Promise<unknown> = async () => ANSWER

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: async function* (query: Query) {
    queries.push(query)
    yield { type: "result", subtype: "success", structured_output: await answer(query) }
  },
}))

vi.mock("../agents/binary.ts", async () => {
  const { succeed } = await import("effect/Effect")
  return { installedBinary: (_provider: string, name: string) => succeed(name) }
})

const DIFF = `diff --git a/src/login.ts b/src/login.ts
index 4cb29ea..ea14db2 100644
--- a/src/login.ts
+++ b/src/login.ts
@@ -1,2 +1,2 @@
 export const login = () => {
-  return check()
+  return check(token)
diff --git a/src/login.test.ts b/src/login.test.ts
new file mode 100644
index 0000000..fa49b07
--- /dev/null
+++ b/src/login.test.ts
@@ -0,0 +1 @@
+test("login", () => {})
`

const ANSWER = {
  overallSummary: "Passes the token to `check`.",
  groups: [
    {
      key: "login",
      label: "Login token",
      summary: "The token reaches the check.",
      category: "security",
      filePaths: ["src/login.ts"],
      lineNotes: [{ path: "src/login.ts", side: "additions", line: 2, text: "Was unchecked before.", critical: true }],
    },
    { key: "tests", label: "Tests", category: "tests", filePaths: ["src/login.test.ts"] },
  ],
}

const pushes: Array<PushEvent> = []
const statuses = new Map<string, PullRequestStatus>()
const heads = new Map<string, string>()

const detail = (url: string, head: string, status: PullRequestStatus = "open") =>
  ({
    url,
    number: 1,
    title: "Check the login token",
    body: "Fixes login.",
    status,
    head,
    additions: 2,
    deletions: 1,
    changedFiles: 2,
  }) as PullRequestDetail

const diffsFetched: Array<string> = []

const gitHub = Layer.mock(GitHub, {
  pullRequestDiff: (url) => Effect.sync(() => void diffsFetched.push(url)).pipe(Effect.as(DIFF)),
  pullRequestDetail: (url) => Effect.succeed(detail(url, heads.get(url) ?? "h1", statuses.get(url) ?? "open")),
})

const base = realpathSync(mkdtempSync(join(tmpdir(), "kk-guides-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const domain = threadsLayer.pipe(
  Layer.provideMerge(Terminals.layer),
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(Projects.layer),
  Layer.provide(AgentAccounts.layer),
  Layer.provideMerge(settingsLayer),
)
const testLayer = guidesLayer.pipe(
  Layer.provideMerge(pullRequestsLayer),
  Layer.provideMerge(Layer.mergeAll(domain, ClientSettings.layer)),
  Layer.provide(Layer.mergeAll(Git.layer, gitHub)),
  Layer.provide(Layer.succeed(Events, { publish: (event) => Effect.sync(() => void pushes.push(event)) })),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

const get = (url: string) => PullRequestGuides.use((guides) => guides.get(url))

const until = (url: string, done: (state: PullRequestGuideState) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const state = yield* get(url)
      if (done(state)) return state
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(new Error(`the guide of ${url} never settled: ${JSON.stringify(yield* get(url))}`))
  })

const ensure = (url: string, head: string, options?: { retry?: boolean }) =>
  PullRequestGuides.use((guides) => guides.ensure(detail(url, head), options))

const queriesFor = (url: string) => queries.filter((query) => query.prompt.includes(url))

const linkToNewThread = (name: string, url: string) =>
  Effect.gen(function* () {
    const rootPath = join(base, name)
    mkdirSync(rootPath)
    const { threadId } = yield* seedThread({ rootPath })
    yield* PullRequests.use((pullRequests) => pullRequests.link(threadId, url))
    return threadId
  })

describe("PullRequestGuides", () => {
  layer(testLayer, { excludeTestServices: true })((it) => {
    it.effect("writes the guide for a head once, with pulls.review's prompt, the settings and read-only tools", () =>
      Effect.gen(function* () {
        const url = "https://github.com/o/once/pull/1"
        yield* Settings.use((settings) =>
          settings.set({ pullRequestGuide: { model: "claude-opus-5-5", effort: "max" } }),
        )
        yield* ensure(url, "h1")
        const { guide, job } = yield* until(url, (state) => state.guide !== null)
        expect(job).toBeNull()
        expect(guide).toMatchObject({ head: "h1", model: "claude-opus-5-5", summary: ANSWER.overallSummary })
        expect(guide?.groups.map((group) => group.filePaths)).toStrictEqual([["src/login.ts"], ["src/login.test.ts"]])

        yield* ensure(url, "h1")
        const [query, ...more] = queriesFor(url)
        expect(more).toStrictEqual([])
        expect(query?.prompt).toContain("login.test.ts")
        expect(query?.prompt).toContain("Respond and categorize in English.")
        expect(query?.options).toMatchObject({
          model: "claude-opus-5-5",
          effort: "max",
          tools: ["Read", "Grep", "Glob"],
          settingSources: [],
          outputFormat: { type: "json_schema" },
        })
        expect(pushes).toContainEqual({ type: "pullRequest.guide", url, state: { guide, job: null } })
      }),
    )

    it.effect("keeps the old guide readable while the next head is written", () =>
      Effect.gen(function* () {
        const url = "https://github.com/o/push/pull/1"
        yield* ensure(url, "h1")
        yield* until(url, (state) => state.guide?.head === "h1")

        const { promise: held, resolve: release } = Promise.withResolvers<void>()
        answer = async () => {
          await held
          return ANSWER
        }
        yield* ensure(url, "h2")
        const writing = yield* get(url)
        expect(writing.guide?.head).toBe("h1")
        expect(writing.job).toStrictEqual({ status: "running", head: "h2" })

        release()
        yield* until(url, (state) => state.guide?.head === "h2" && state.job === null)
        answer = async () => ANSWER
      }),
    )

    it.effect("does not try a failed head again until asked to", () =>
      Effect.gen(function* () {
        const url = "https://github.com/o/broken/pull/1"
        answer = async () => {
          throw new Error("usage limit reached")
        }
        yield* ensure(url, "h1")
        const failed = yield* until(url, (state) => state.job?.status === "failed")
        expect(failed).toStrictEqual({
          guide: null,
          job: { status: "failed", head: "h1", message: expect.stringContaining("usage limit reached") },
        })

        yield* ensure(url, "h1")
        expect(queriesFor(url)).toHaveLength(1)

        answer = async () => ANSWER
        yield* ensure(url, "h1", { retry: true })
        yield* until(url, (state) => state.guide?.head === "h1")
        expect(queriesFor(url)).toHaveLength(2)
      }),
    )

    it.effect("a merged or closed pull request gets no guide", () =>
      Effect.gen(function* () {
        const merged = "https://github.com/o/merged/pull/1"
        yield* PullRequestGuides.use((guides) => guides.ensure(detail(merged, "h1", "merged")))
        expect(yield* get(merged)).toStrictEqual({ guide: null, job: null })
        expect(queriesFor(merged)).toStrictEqual([])
      }),
    )

    it.effect("a pull request GitHub cannot diff gets no guide and its diff is never asked for", () =>
      Effect.gen(function* () {
        const lines = "https://github.com/o/many-lines/pull/1"
        const files = "https://github.com/o/many-files/pull/1"
        yield* PullRequestGuides.use((guides) =>
          Effect.all([
            guides.ensure({ ...detail(lines, "h1"), additions: 15_000, deletions: 5_001 }),
            guides.ensure({ ...detail(files, "h1"), changedFiles: 301 }),
          ]),
        )
        expect(yield* get(lines)).toStrictEqual({ guide: null, job: null })
        expect(yield* get(files)).toStrictEqual({ guide: null, job: null })
        expect(diffsFetched).not.toContain(lines)
        expect(diffsFetched).not.toContain(files)
      }),
    )

    it.effect("the sweep covers open pull requests linked to threads that are not archived", () =>
      Effect.gen(function* () {
        const live = "https://github.com/o/live/pull/1"
        const closed = "https://github.com/o/closed/pull/1"
        const archived = "https://github.com/o/archived/pull/1"
        yield* linkToNewThread("live", live)
        yield* linkToNewThread("closed", closed)
        statuses.set(closed, "closed")
        const archivedThread = yield* linkToNewThread("archived", archived)
        yield* Threads.use((threads) => threads.archive(archivedThread))

        yield* PullRequestGuides.use((guides) => guides.sweep)
        yield* until(live, (state) => state.guide !== null)
        expect(queriesFor(closed)).toStrictEqual([])
        expect(queriesFor(archived)).toStrictEqual([])
      }),
    )
  })
})
