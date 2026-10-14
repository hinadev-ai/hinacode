import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as McpCredentials from "../mcp/credentials.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import { AgentRunner, layer as runnerLayer } from "./AgentRunner.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import { GitHub } from "./GitHub.ts"
import { Messages, layer as messagesLayer } from "./Messages.ts"
import * as Projects from "./Projects.ts"
import { PullRequests, layer as pullRequestsLayer } from "./PullRequests.ts"
import { PullRequestWatcher, layer as watcherLayer } from "./PullRequestWatcher.ts"
import { Secrets } from "./Secrets.ts"
import { layer as settingsLayer } from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { ThreadNaming } from "./ThreadNaming.ts"
import { layer as threadsLayer } from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"

const base = realpathSync(mkdtempSync(join(tmpdir(), "kk-watch-delivery-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

type Hold = { readonly asked: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
const providerHolds = new Map<string, Hold>()
const transcriptHolds = new Map<string, Hold>()
const currentReads = new Map<string, Deferred.Deferred<void>>()
const inputs: Array<{ readonly threadId: string; readonly text: string }> = []
const starts: Array<{ readonly threadId: string; readonly text: string }> = []

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: (input) =>
    Stream.fromEffect(Effect.sync(() => void starts.push({ threadId: input.threadId, text: input.prompt }))).pipe(
      Stream.drain,
      Stream.concat(Stream.never),
    ),
  steer: (threadId, text) =>
    Effect.gen(function* () {
      const hold = providerHolds.get(threadId)
      if (hold && text === "busy input") {
        yield* Deferred.succeed(hold.asked, undefined)
        yield* Deferred.await(hold.release)
      }
      inputs.push({ threadId, text })
    }),
  interrupt: () => Effect.void,
  respondApproval: () => Effect.void,
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const observedMessages = Layer.effect(
  Messages,
  Effect.map(Messages, (messages) => ({
    ...messages,
    list: (threadId: string) =>
      Effect.gen(function* () {
        const hold = transcriptHolds.get(threadId)
        if (hold) {
          yield* Deferred.succeed(hold.asked, undefined)
          yield* Deferred.await(hold.release)
        }
        return yield* messages.list(threadId)
      }),
  })),
).pipe(Layer.provide(messagesLayer))

const observedPullRequests = Layer.effect(
  PullRequests,
  Effect.map(PullRequests, (pullRequests) => ({
    ...pullRequests,
    find: (linkId: string) =>
      pullRequests.find(linkId).pipe(
        Effect.tap(() => {
          const asked = currentReads.get(linkId)
          return asked === undefined ? Effect.void : Deferred.succeed(asked, undefined)
        }),
      ),
  })),
)

const domain = threadsLayer.pipe(
  Layer.provideMerge(Terminals.layer),
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(Projects.layer),
  Layer.provideMerge(AgentAccounts.layer),
  Layer.provideMerge(settingsLayer),
)
const core = Layer.mergeAll(observedMessages, pullRequestsLayer.pipe(Layer.provideMerge(domain)), McpCredentials.layer)
const agents = runnerLayer.pipe(
  Layer.provideMerge(core),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(ClaudeProvider, provider("claude")),
      Layer.succeed(CodexProvider, provider("codex")),
      Layer.succeed(MuseProvider, provider("muse")),
      Layer.mock(Secrets, {}),
      Layer.succeed(ThreadNaming, { nameFromPrompt: () => Effect.void }),
    ),
  ),
)
const testLayer = watcherLayer.pipe(
  Layer.provideMerge(observedPullRequests.pipe(Layer.provideMerge(agents))),
  Layer.provide(
    Layer.mergeAll(
      Git.layer,
      Layer.mock(GitHub, {
        pullRequestDetail: (url) =>
          Effect.succeed({
            url,
            number: 7,
            title: "Fix the thing",
            status: "open",
            checks: "failing",
            review: null,
            author: "octocat",
            headRefName: "feat/fix",
            baseRefName: "main",
            additions: 1,
            deletions: 0,
            body: "",
            baseRef: "main",
            headRef: "feat/fix",
            head: "abc1234",
            mergeable: "mergeable",
            checkRuns: [{ name: "CI / test", status: "failing", url: "https://ci.example/test" }],
          }),
      }),
    ),
  ),
  Layer.provide(Layer.succeed(Events, { publish: () => Effect.void })),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

const watchedThread = (name: string) =>
  Effect.gen(function* () {
    const rootPath = join(base, name)
    execFileSync("git", ["init", "-q", "-b", "main", rootPath])
    execFileSync("git", [
      "-C",
      rootPath,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "init",
      "--allow-empty",
    ])
    const { threadId } = yield* seedThread({ rootPath })
    const url = `https://github.com/o/${name}/pull/7`
    const link = yield* PullRequests.use((pullRequests) => pullRequests.watch(threadId, url))
    const asked = yield* Deferred.make<void>()
    currentReads.set(link.id, asked)
    return { threadId, url, link, asked }
  })

const hold = Effect.gen(function* () {
  return { asked: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
})
const sweep = PullRequestWatcher.use((watcher) => watcher.sweep)

describe("PullRequestWatcher queued delivery", () => {
  layer(testLayer)((it) => {
    it.effect("drops stopped watch news queued behind active steering", () =>
      Effect.gen(function* () {
        const { threadId, url, asked, link } = yield* watchedThread("active")
        yield* McpCredentials.McpCredentials.use((credentials) => credentials.listening("http://127.0.0.1:1/mcp"))
        const runner = yield* AgentRunner
        yield* runner.send(threadId, "initial input", [])
        const busy = yield* hold
        providerHolds.set(threadId, busy)
        const steering = yield* Effect.forkChild(runner.steer(threadId, "busy input", []))
        yield* Deferred.await(busy.asked)
        const polling = yield* Effect.forkChild(sweep)
        yield* Deferred.await(asked)

        const pullRequests = yield* PullRequests
        yield* pullRequests.unwatch(threadId, url)
        const replacement = yield* pullRequests.watch(threadId, url, ["reviewChanged"])
        yield* Deferred.succeed(busy.release, undefined)
        yield* Fiber.join(steering)
        yield* Fiber.join(polling)

        expect(inputs.filter((input) => input.threadId === threadId).map((input) => input.text)).toStrictEqual([
          "busy input",
        ])
        expect((yield* pullRequests.find(link.id))?.watch).toStrictEqual(replacement.watch)
      }),
    )

    it.effect("drops stopped watch news queued behind an idle transcript read", () =>
      Effect.gen(function* () {
        const { threadId, url, asked, link } = yield* watchedThread("idle")
        const busy = yield* hold
        transcriptHolds.set(threadId, busy)
        const reading = yield* Effect.forkChild(AgentRunner.use((runner) => runner.transcript(threadId)))
        yield* Deferred.await(busy.asked)
        const polling = yield* Effect.forkChild(sweep)
        yield* Deferred.await(asked)

        const pullRequests = yield* PullRequests
        yield* pullRequests.unwatch(threadId, url)
        const replacement = yield* pullRequests.watch(threadId, url, ["reviewChanged"])
        yield* Deferred.succeed(busy.release, undefined)
        yield* Fiber.join(reading)
        yield* Fiber.join(polling)

        expect(starts.filter((input) => input.threadId === threadId)).toStrictEqual([])
        expect((yield* pullRequests.find(link.id))?.watch).toStrictEqual(replacement.watch)
        expect((yield* AgentRunner.use((runner) => runner.transcript(threadId))).messages).toStrictEqual([])

        yield* AgentRunner.use((runner) => runner.send(threadId, "next input", []))
        const transcript = yield* AgentRunner.use((runner) => runner.transcript(threadId))
        expect(transcript.messages[0]?.parts).toStrictEqual([{ type: "text", text: "next input" }])
      }),
    )
  })
})
