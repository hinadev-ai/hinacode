import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Deferred, Effect, Layer, PubSub, Stream } from "effect"
import { vi } from "vitest"
import type { AgentEvent } from "../../shared/agent.ts"
import type { PushEvent } from "../../shared/contract.ts"
import type { WorktreeSource } from "../../shared/domain.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import * as Db from "../db/client.ts"
import { McpCredentials, layer as credentialsLayer } from "../mcp/credentials.ts"
import * as AgentRunner from "./AgentRunner.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import * as Messages from "./Messages.ts"
import * as Projects from "./Projects.ts"
import * as PullRequests from "./PullRequests.ts"
import * as Secrets from "./Secrets.ts"
import * as Settings from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import * as ThreadNaming from "./ThreadNaming.ts"
import * as Threads from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: async function* () {
    yield { type: "result", subtype: "success", structured_output: { title: "Review login", branch: "review-login" } }
  },
}))

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const commit = (cwd: string, message: string) =>
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", message)

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([]),
  account: Effect.succeed({ type: "signedOut" }),
  listCommands: () => Effect.succeed([]),
  runTurn: () => Stream.fromIterable<AgentEvent>([{ type: "turn_completed" }]),
  steer: () => Effect.void,
  interrupt: () => Effect.void,
  respondApproval: () => Effect.void,
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const heads: Record<string, GitHub.PullRequestHead> = {
  "7": {
    url: "https://github.com/acme/repo/pull/7",
    number: 7,
    headRefName: "feature/login",
    baseRefName: "main",
    isCrossRepository: false,
  },
  "8": {
    url: "https://github.com/acme/repo/pull/8",
    number: 8,
    headRefName: "fork-work",
    baseRefName: "main",
    isCrossRepository: true,
  },
}

const github = Layer.effect(
  GitHub.GitHub,
  Effect.gen(function* () {
    const real = yield* GitHub.GitHub
    return GitHub.GitHub.of({
      ...real,
      pullRequestHead: (_cwd, selector) => Effect.succeed(heads[selector]!),
      repository: () => Effect.succeed({ owner: "acme", name: "repo" }),
    })
  }),
).pipe(Layer.provide(GitHub.layer))

const observedNaming = (named: Deferred.Deferred<void>) =>
  Layer.effect(
    ThreadNaming.ThreadNaming,
    Effect.gen(function* () {
      const naming = yield* ThreadNaming.ThreadNaming
      return ThreadNaming.ThreadNaming.of({
        nameFromPrompt: (...args: Parameters<typeof naming.nameFromPrompt>) =>
          naming.nameFromPrompt(...args).pipe(Effect.ensuring(Deferred.succeed(named, undefined))),
      })
    }),
  ).pipe(Layer.provide(ThreadNaming.layer))

const makeLayer = (dbPath: string, pushes: PubSub.PubSub<PushEvent>, named: Deferred.Deferred<void>) => {
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provideMerge(Terminals.layer),
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(Settings.layer),
    ),
    Messages.layer,
    Secrets.layer,
    credentialsLayer,
  )
  return AgentRunner.layer.pipe(
    Layer.provideMerge(observedNaming(named).pipe(Layer.provide(domain))),
    Layer.provideMerge(PullRequests.layer.pipe(Layer.provide(domain))),
    Layer.provideMerge(domain),
    Layer.provide(
      Layer.mergeAll(
        Git.layer,
        github,
        Layer.succeed(ClaudeProvider, provider("claude")),
        Layer.succeed(CodexProvider, provider("codex")),
        Layer.succeed(Events, { publish: (event) => Effect.asVoid(PubSub.publish(pushes, event)) }),
      ),
    ),
    Layer.provideMerge(Db.layer(dbPath)),
    Layer.provide(NodeServices.layer),
  )
}

const makeRepo = (dir: string) => {
  const root = join(dir, "repo")
  const origin = join(dir, "origin.git")
  execFileSync("git", ["init", "-q", "-b", "main", root])
  execFileSync("git", ["init", "-q", "--bare", origin])
  commit(root, "init")
  git(root, "remote", "add", "origin", origin)
  git(root, "push", "-q", "origin", "main")
  git(root, "switch", "-q", "-c", "feature/login")
  commit(root, "fix login")
  git(root, "push", "-q", "origin", "feature/login")
  git(root, "switch", "-q", "-c", "fork-work", "main")
  commit(root, "fork change")
  git(root, "push", "-q", "origin", "fork-work:refs/pull/8/head")
  git(root, "switch", "-q", "main")
  git(root, "branch", "-q", "-D", "feature/login", "fork-work")
  git(root, "update-ref", "-d", "refs/remotes/origin/feature/login")
  return root
}

const inspect = (threadId: string) =>
  Effect.gen(function* () {
    const thread = yield* Threads.Threads.use((threads) => threads.get(threadId))
    const worktree = yield* Worktrees.Worktrees.use((worktrees) => worktrees.get(thread.worktreeId!))
    const upstream = spawnSync("git", ["-C", worktree.path, "rev-parse", "--abbrev-ref", "@{upstream}"], {
      encoding: "utf8",
    })
    const push = spawnSync("git", ["-C", worktree.path, "-c", "push.default=simple", "push", "--dry-run"], {
      encoding: "utf8",
    })
    return {
      title: thread.title,
      branch: git(worktree.path, "branch", "--show-current"),
      recordedBranch: worktree.branch,
      upstream: upstream.status === 0 ? upstream.stdout.trim() : null,
      pushSucceeds: push.status === 0,
    }
  })

const nameAfter = <E>(
  act: (
    threadId: string,
  ) => Effect.Effect<void, E, AgentRunner.AgentRunner | Threads.Threads | PullRequests.PullRequests>,
) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      // macOS links the temp dir through /private, and git reports worktree paths fully resolved.
      Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "kk-naming-test-")))),
      (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
    )
    const root = makeRepo(dir)
    const pushes = yield* PubSub.unbounded<PushEvent>()
    const named = yield* Deferred.make<void>()
    return yield* Effect.gen(function* () {
      const updates = yield* PubSub.subscribe(pushes)
      yield* McpCredentials.use((credentials) => credentials.listening("http://127.0.0.1:1/mcp"))
      const project = yield* Projects.Projects.use((projects) =>
        projects.create({ name: "repo", rootPath: root, setupScript: null }),
      )
      const thread = yield* Threads.Threads.use((threads) =>
        threads.create({ projectId: project.id, title: "t", provider: "claude", model: "claude-sonnet-5-5" }),
      )
      yield* act(thread.id)
      yield* Deferred.await(named)
      while (true) {
        const event = yield* PubSub.take(updates)
        if (event.type === "worktree.updated" && event.worktree.status === "ready") break
      }
      return yield* inspect(thread.id)
    }).pipe(Effect.scoped, Effect.provide(makeLayer(join(dir, "kkcode.sqlite"), pushes, named)))
  }).pipe(Effect.scoped)

const PROMPT = "Review this pull request"

const send = (threadId: string, worktree?: WorktreeSource) =>
  AgentRunner.AgentRunner.use((runner) => runner.send(threadId, PROMPT, [], { worktree }))

describe("naming a thread from its first message", () => {
  it.live("keeps a same-repository pull request's branch and upstream, so a plain push still updates it", () =>
    Effect.gen(function* () {
      const named = yield* nameAfter((threadId) => send(threadId, { _tag: "pullRequest", selector: "7" }))
      expect(named).toStrictEqual({
        title: "Review login",
        branch: "feature/login",
        recordedBranch: "feature/login",
        upstream: "origin/feature/login",
        pushSucceeds: true,
      })
    }),
  )

  it.live("keeps a fork's pull request on its kk/pr-<number> branch", () =>
    Effect.gen(function* () {
      const named = yield* nameAfter((threadId) => send(threadId, { _tag: "pullRequest", selector: "8" }))
      expect({ title: named.title, branch: named.branch, recordedBranch: named.recordedBranch }).toStrictEqual({
        title: "Review login",
        branch: "kk/pr-8",
        recordedBranch: "kk/pr-8",
      })
    }),
  )

  it.live("keeps the pull request's branch when the first message is resent after the checkout was attached", () =>
    Effect.gen(function* () {
      const named = yield* nameAfter((threadId) =>
        Effect.gen(function* () {
          const { pullRequestUrl } = yield* Threads.Threads.use((threads) =>
            threads.attachWorktree(threadId, { _tag: "pullRequest", selector: "7" }),
          )
          yield* PullRequests.PullRequests.use((pullRequests) => pullRequests.link(threadId, pullRequestUrl!))
          yield* send(threadId)
        }),
      )
      expect(named).toStrictEqual({
        title: "Review login",
        branch: "feature/login",
        recordedBranch: "feature/login",
        upstream: "origin/feature/login",
        pushSucceeds: true,
      })
    }),
  )

  it.live("renames a branch created for the new task", () =>
    Effect.gen(function* () {
      const named = yield* nameAfter((threadId) => send(threadId, { _tag: "branch", baseRef: "main" }))
      expect({ title: named.title, branch: named.branch, recordedBranch: named.recordedBranch }).toStrictEqual({
        title: "Review login",
        branch: "kk/review-login",
        recordedBranch: "kk/review-login",
      })
    }),
  )
})
