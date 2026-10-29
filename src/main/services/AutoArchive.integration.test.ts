import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, watch } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
import type { PushEvent } from "../../shared/contract.ts"
import type { PullRequest, PullRequestDetail, PullRequestStatus, ThreadStatus } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import { AutoArchive, layer as autoArchiveLayer } from "./AutoArchive.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import { GitHub } from "./GitHub.ts"
import * as Projects from "./Projects.ts"
import { PullRequests, layer as pullRequestsLayer } from "./PullRequests.ts"
import { Settings, layer as settingsLayer } from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { Threads, layer as threadsLayer } from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"
import * as Scratch from "./Scratch.ts"

const pushes: Array<PushEvent> = []
const statuses = new Map<string, PullRequestStatus>()
const heads = new Map<string, string>()
const headOids = new Map<string, string>()

const held = new Map<string, { readonly asked: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }>()

const gitHub = Layer.mock(GitHub, {
  pullRequest: (url) =>
    Effect.gen(function* () {
      const hold = held.get(url)
      if (hold) {
        yield* Deferred.succeed(hold.asked, undefined)
        yield* Deferred.await(hold.release)
      }
      const number = Number(url.split("/").at(-1))
      return { url, number, status: statuses.get(url) ?? "open", headRefName: heads.get(url) ?? "" } as PullRequest
    }),
  branchPullRequest: (_cwd, branch) => {
    const url = [...heads].findLast(([, head]) => head === branch)?.[0]
    return Effect.succeed(url === undefined ? null : ({ url, status: statuses.get(url) ?? "open" } as PullRequest))
  },
  pullRequestDetail: (url) => Effect.succeed({ url, head: headOids.get(url) ?? "" } as PullRequestDetail),
})

const base = realpathSync(mkdtempSync(join(tmpdir(), "kk-auto-archive-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const domain = threadsLayer.pipe(
  Layer.provideMerge(Scratch.layer(mkdtempSync(join(tmpdir(), "kk-scratch-")))),
  Layer.provideMerge(Terminals.layer),
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(Projects.layer),
  Layer.provide(AgentAccounts.layer),
  Layer.provideMerge(settingsLayer(mkdtempSync(join(tmpdir(), "kk-auto-archive-settings-")))),
)
const testLayer = autoArchiveLayer.pipe(
  Layer.provideMerge(pullRequestsLayer),
  Layer.provideMerge(domain),
  Layer.provide(Layer.mergeAll(Git.layer, gitHub)),
  Layer.provide(Layer.succeed(Events, { publish: (event) => Effect.sync(() => void pushes.push(event)) })),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

const pullRequestUrl = (name: string, index = 0) => `https://github.com/o/${name}/pull/${index + 1}`

/** A thread in its own project, linked to one pull request per given status. */
const threadWithPullRequests = (name: string, prStatuses: ReadonlyArray<PullRequestStatus>, status?: ThreadStatus) =>
  Effect.gen(function* () {
    const rootPath = join(base, name)
    mkdirSync(rootPath)
    const { threadId } = yield* seedThread({ rootPath })
    if (status) yield* Threads.use((threads) => threads.update({ id: threadId, status }))
    yield* Effect.forEach(prStatuses, (prStatus, index) => {
      const url = pullRequestUrl(name, index)
      statuses.set(url, prStatus)
      return PullRequests.use((pullRequests) => pullRequests.link(threadId, url))
    })
    return threadId
  })

const statusOf = (id: string) => Threads.use((threads) => threads.get(id)).pipe(Effect.map((thread) => thread.status))

describe("AutoArchive", () => {
  layer(testLayer)((it) => {
    it.effect("leaves every thread alone while the setting is off", () =>
      Effect.gen(function* () {
        const merged = yield* threadWithPullRequests("off", ["merged"])
        yield* AutoArchive.use((autoArchive) => autoArchive.sweep)
        expect(yield* statusOf(merged)).toBe("idle")
      }),
    )

    it.effect("archives only threads whose linked pull requests have all merged or closed", () =>
      Effect.gen(function* () {
        yield* Settings.use((settings) => settings.set({ archive: { whenMerged: true, removeWorktree: false } }))
        const allMerged = yield* threadWithPullRequests("all", ["merged", "closed"])
        const oneOpen = yield* threadWithPullRequests("some", ["merged", "open"])
        const closed = yield* threadWithPullRequests("closed", ["closed"])
        const running = yield* threadWithPullRequests("running", ["merged"], "running")
        const unlinked = (yield* seedThread({ rootPath: "/unlinked" })).threadId

        yield* AutoArchive.use((autoArchive) => autoArchive.sweep)

        expect(yield* statusOf(allMerged)).toBe("archived")
        expect(yield* statusOf(oneOpen)).toBe("idle")
        expect(yield* statusOf(closed)).toBe("archived")
        expect(yield* statusOf(running)).toBe("running")
        expect(yield* statusOf(unlinked)).toBe("idle")
        expect(pushes).toContainEqual(
          expect.objectContaining({ type: "thread.updated", thread: expect.objectContaining({ id: allMerged }) }),
        )
      }),
    )

    for (const status of ["running", "awaiting_approval"] as const) {
      it.effect(`leaves a thread alone when it went ${status} while GitHub was answering`, () =>
        Effect.gen(function* () {
          yield* Settings.use((settings) => settings.set({ archive: { whenMerged: true, removeWorktree: false } }))
          const name = `raced-${status}`
          const threadId = yield* threadWithPullRequests(name, ["merged"])
          const hold = { asked: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
          held.set(pullRequestUrl(name), hold)
          const terminal = yield* Terminals.Terminals.use((terminals) =>
            terminals.open({ threadId, cols: 80, rows: 24 }),
          )

          const sweep = yield* AutoArchive.use((autoArchive) => autoArchive.sweep).pipe(Effect.forkChild)
          yield* Deferred.await(hold.asked)
          yield* Threads.use((threads) => threads.update({ id: threadId, status }))
          yield* Deferred.succeed(hold.release, undefined)
          yield* Fiber.join(sweep)

          expect(yield* statusOf(threadId)).toBe(status)
          expect(yield* Terminals.Terminals.use((terminals) => terminals.list(threadId))).toStrictEqual([terminal])
          expect(pushes).not.toContainEqual(
            expect.objectContaining({
              type: "thread.updated",
              thread: expect.objectContaining({ id: threadId, status: "archived" }),
            }),
          )
          yield* Terminals.Terminals.use((terminals) => terminals.close(terminal.id))
        }),
      )
    }
  })
})

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" })

const localBranches = (root: string) =>
  git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).toSorted()

/** Worktree removal deletes the checkout and branch in the background; the parent directory reports each. */
const waitUntilGone = (path: string) =>
  Effect.callback<void>((resume) => {
    let done = false
    const check = () => {
      if (done || existsSync(path)) return
      done = true
      watcher.close()
      resume(Effect.void)
    }
    const watcher = watch(dirname(path), check)
    check()
    return Effect.sync(() => watcher.close())
  })

const waitUntilBranchGone = (root: string, branch: string) => waitUntilGone(join(root, ".git", "refs", "heads", branch))

/** A git repo registered as a project. */
const project = (name: string) =>
  Effect.gen(function* () {
    const root = join(base, name)
    execFileSync("git", ["init", "-q", "-b", "main", root])
    git(root, "commit", "-q", "--allow-empty", "-m", "init")
    const { id } = yield* Projects.Projects.use((projects) =>
      projects.create({ name, rootPath: root, setupScript: null }),
    )
    return { root, projectId: id }
  })

/** A thread in its own worktree with one commit on its branch, so the branch is unmerged until GitHub says so. */
const worktreeThread = (projectId: string, branch: string, baseRef = "main") =>
  Effect.gen(function* () {
    const thread = yield* Threads.use((threads) =>
      threads.create({ projectId, title: branch, provider: "claude", model: "m", worktree: { branch, baseRef } }),
    )
    const worktree = yield* Worktrees.Worktrees.use((worktrees) => worktrees.whenPrepared(thread.worktreeId!))
    git(worktree.path, "commit", "-q", "--allow-empty", "-m", branch)
    return { threadId: thread.id, path: worktree.path }
  })

const nextNumber = () => heads.size + 1

/** Links the pull request of `branch` to the thread, opened in the given status from `head`, the worktree's tip by default. */
const linkPullRequest = (
  thread: { readonly threadId: string; readonly path: string },
  branch: string,
  status: PullRequestStatus,
  head = git(thread.path, "rev-parse", "HEAD").trim(),
) =>
  Effect.gen(function* () {
    const url = `https://github.com/o/r/pull/${nextNumber()}`
    heads.set(url, branch)
    headOids.set(url, head)
    statuses.set(url, status)
    yield* PullRequests.use((pullRequests) => pullRequests.link(thread.threadId, url))
    return url
  })

const setStatus = (url: string, status: PullRequestStatus) => Effect.sync(() => void statuses.set(url, status))

const sweep = AutoArchive.use((autoArchive) => autoArchive.sweep)

/** Checks `branch` out again, which waits for the removal before it, and expects it still at `tip`. */
const expectBranchAt = (projectId: string, branch: string, tip: string) =>
  Effect.gen(function* () {
    const worktree = yield* Worktrees.Worktrees.use((worktrees) =>
      worktrees
        .create({ projectId, branch, baseRef: "main" })
        .pipe(Effect.flatMap((created) => worktrees.whenPrepared(created.id))),
    )
    expect(git(worktree.path, "rev-parse", "HEAD").trim()).toBe(tip)
  })

describe("worktree cleanup across threads", () => {
  layer(testLayer)((it) => {
    const cleanupOn = Settings.use((settings) => settings.set({ archive: { whenMerged: true, removeWorktree: true } }))

    it.effect("removes a worktree and its squash-merged branch once its pull request merges", () =>
      Effect.gen(function* () {
        yield* cleanupOn
        const { root, projectId } = yield* project("squash")
        const child = yield* worktreeThread(projectId, "kk/child")
        yield* linkPullRequest(child, "kk/child", "merged")

        yield* sweep

        expect(yield* statusOf(child.threadId)).toBe("archived")
        yield* waitUntilGone(child.path)
        yield* waitUntilBranchGone(root, "kk/child")
        expect(localBranches(root)).toStrictEqual(["main"])
      }),
    )

    it.effect("removes the worktree of a fork's pull request, checked out as kk/pr-N, once it merges", () =>
      Effect.gen(function* () {
        yield* cleanupOn
        const { projectId } = yield* project("fork")
        const fork = yield* worktreeThread(projectId, `kk/pr-${nextNumber()}`)
        yield* linkPullRequest(fork, "contributor/feature", "merged")

        yield* sweep

        expect(yield* statusOf(fork.threadId)).toBe("archived")
        yield* waitUntilGone(fork.path)
      }),
    )

    it.effect("keeps a branch with commits made after its pull request merged", () =>
      Effect.gen(function* () {
        yield* cleanupOn
        const { projectId } = yield* project("after-merge")
        const child = yield* worktreeThread(projectId, "kk/after-merge")
        yield* linkPullRequest(child, "kk/after-merge", "merged")
        git(child.path, "commit", "-q", "--allow-empty", "-m", "after merge")
        const tip = git(child.path, "rev-parse", "HEAD").trim()

        yield* sweep

        expect(yield* statusOf(child.threadId)).toBe("archived")
        yield* waitUntilGone(child.path)
        yield* expectBranchAt(projectId, "kk/after-merge", tip)
      }),
    )

    it.effect("keeps a reused branch whose name an older merged pull request had", () =>
      Effect.gen(function* () {
        yield* cleanupOn
        const { root, projectId } = yield* project("reused")
        const oldHead = git(root, "commit-tree", "-p", "main", "-m", "old work", "main^{tree}").trim()
        const child = yield* worktreeThread(projectId, "kk/reused")
        yield* linkPullRequest(child, "kk/reused", "merged", oldHead)
        const tip = git(child.path, "rev-parse", "HEAD").trim()

        yield* sweep

        expect(yield* statusOf(child.threadId)).toBe("archived")
        yield* waitUntilGone(child.path)
        yield* expectBranchAt(projectId, "kk/reused", tip)
      }),
    )

    it.effect("removes the worktree of a closed pull request and keeps its unmerged branch", () =>
      Effect.gen(function* () {
        yield* cleanupOn
        const { root, projectId } = yield* project("closed-pr")
        const child = yield* worktreeThread(projectId, "kk/abandoned")
        yield* linkPullRequest(child, "kk/abandoned", "closed")

        yield* sweep

        expect(yield* statusOf(child.threadId)).toBe("archived")
        yield* waitUntilGone(child.path)
        expect(localBranches(root)).toStrictEqual(["kk/abandoned", "main"])
      }),
    )

    it.effect("cleans up a conductor once its own pull request merges, while a child's linked one is open", () =>
      Effect.gen(function* () {
        yield* cleanupOn
        const { root, projectId } = yield* project("conductor")
        const conductor = yield* worktreeThread(projectId, "kk/conductor")
        const child = yield* worktreeThread(projectId, "kk/worker")
        yield* linkPullRequest(conductor, "kk/conductor", "merged")
        const childUrl = yield* linkPullRequest(child, "kk/worker", "open")
        yield* PullRequests.use((pullRequests) => pullRequests.link(conductor.threadId, childUrl))

        yield* sweep

        expect(yield* statusOf(conductor.threadId)).toBe("archived")
        expect(yield* statusOf(child.threadId)).toBe("idle")
        yield* waitUntilGone(conductor.path)
        expect(existsSync(child.path)).toBe(true)

        yield* setStatus(childUrl, "merged")
        yield* sweep

        expect(yield* statusOf(child.threadId)).toBe("archived")
        yield* waitUntilGone(child.path)
        yield* waitUntilBranchGone(root, "kk/conductor")
        yield* waitUntilBranchGone(root, "kk/worker")
        expect(localBranches(root)).toStrictEqual(["main"])
      }),
    )

    it.effect("keeps a conductor that still watches a child's open pull request", () =>
      Effect.gen(function* () {
        yield* cleanupOn
        const { projectId } = yield* project("watching")
        const conductor = yield* worktreeThread(projectId, "kk/watcher")
        const child = yield* worktreeThread(projectId, "kk/watched")
        yield* linkPullRequest(conductor, "kk/watcher", "merged")
        const childUrl = yield* linkPullRequest(child, "kk/watched", "open")
        yield* PullRequests.use((pullRequests) => pullRequests.watch(conductor.threadId, childUrl))

        yield* sweep

        expect(yield* statusOf(conductor.threadId)).toBe("idle")
        expect(existsSync(conductor.path)).toBe(true)
      }),
    )

    for (const order of [
      ["parent", "child"],
      ["child", "parent"],
    ] as const) {
      it.effect(`converges for a stacked child when the ${order[0]} merges first`, () =>
        Effect.gen(function* () {
          yield* cleanupOn
          const { root, projectId } = yield* project(`stacked-${order[0]}-first`)
          const parent = yield* worktreeThread(projectId, "kk/parent")
          const child = yield* worktreeThread(projectId, "kk/stacked", "kk/parent")
          const threads = { parent, child }
          const urls = {
            parent: yield* linkPullRequest(parent, "kk/parent", "open"),
            child: yield* linkPullRequest(child, "kk/stacked", "open"),
          }
          const [first, second] = order

          yield* setStatus(urls[first], "merged")
          yield* sweep

          yield* waitUntilGone(threads[first].path)
          expect(yield* statusOf(threads[second].threadId)).toBe("idle")
          if (second === "child") {
            const changes = yield* Threads.use((all) => all.changes(child.threadId, "worktree"))
            expect(changes).not.toBeNull()
          }

          yield* setStatus(urls[second], "merged")
          yield* sweep
          yield* sweep

          expect(yield* statusOf(threads[second].threadId)).toBe("archived")
          yield* waitUntilGone(threads[second].path)
          yield* waitUntilBranchGone(root, "kk/parent")
          yield* waitUntilBranchGone(root, "kk/stacked")
          expect(localBranches(root)).toStrictEqual(["main"])
        }),
      )
    }
  })
})
