import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, watch, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/sql"
import type { PushEvent } from "../../shared/contract.ts"
import type { BackgroundTask, Subagent } from "../../shared/agent.ts"
import type {
  ArchiveSettings,
  PullRequest,
  PullRequestDetail,
  PullRequestStatus,
  ThreadStatus,
} from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import { Settle, layer as settleLayer } from "./Settle.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import { AgentRunner } from "./AgentRunner.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import { GitHub } from "./GitHub.ts"
import * as Ports from "./Ports.ts"
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

const mergedAts = new Map<string, string>()
const held = new Map<string, { readonly asked: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }>()

const gitHub = Layer.mock(GitHub, {
  installed: Effect.succeed(true),
  pullRequest: (url) =>
    Effect.gen(function* () {
      const hold = held.get(url)
      if (hold) {
        yield* Deferred.succeed(hold.asked, undefined)
        yield* Deferred.await(hold.release)
      }
      const number = Number(url.split("/").at(-1))
      return {
        url,
        number,
        status: statuses.get(url) ?? "open",
        headRefName: heads.get(url) ?? "",
        mergedAt: mergedAts.get(url),
      } as PullRequest
    }),
  branchPullRequest: (_cwd, branch) => {
    const url = [...heads].findLast(([, head]) => head === branch)?.[0]
    return Effect.succeed(url === undefined ? null : ({ url, status: statuses.get(url) ?? "open" } as PullRequest))
  },
  pullRequestDetail: (url) => Effect.succeed({ url, head: headOids.get(url) ?? "" } as PullRequestDetail),
})

const backgroundTasks = new Map<string, ReadonlyArray<BackgroundTask>>()
const subagents = new Map<string, ReadonlyArray<Subagent>>()
const released: Array<string> = []
const turnStarted = new Set<string>()
const heldReleases = new Map<
  string,
  { readonly asked: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
>()

const agentRunner = Layer.mock(AgentRunner, {
  backgroundTasks: (threadId) => Effect.succeed(backgroundTasks.get(threadId) ?? []),
  subagents: (threadId) => Effect.succeed(subagents.get(threadId) ?? []),
  release: (threadId, whileIdle) =>
    Effect.gen(function* () {
      released.push(threadId)
      const hold = heldReleases.get(threadId)
      if (hold) {
        yield* Deferred.succeed(hold.asked, undefined)
        yield* Deferred.await(hold.release)
      }
      return turnStarted.has(threadId) ? Option.none() : Option.some(yield* whileIdle)
    }),
})

const portsClosedFor: Array<string> = []
const failingScans = new Set<string>()

const recordingPorts = Layer.effect(
  Ports.Ports,
  Ports.Ports.use((ports) =>
    Effect.succeed(
      Ports.Ports.of({
        ...ports,
        listForThread: (threadId) =>
          failingScans.has(threadId)
            ? Effect.fail(new Ports.PortsError({ message: "ss is not installed" }))
            : ports.listForThread(threadId),
        closeThread: (threadId) =>
          Effect.sync(() => void portsClosedFor.push(threadId)).pipe(Effect.andThen(ports.closeThread(threadId))),
      }),
    ),
  ),
).pipe(Layer.provide(Ports.layer))

const listenerPids: Array<number> = []

const LISTENER =
  "const s = require('net').createServer((socket) => socket.end('alive')).listen(0, '127.0.0.1', () => console.log(process.pid, s.address().port))"

const answersOn = (port: number) =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        let reply = ""
        const socket = connect(port, "127.0.0.1")
        socket.on("data", (chunk) => (reply += String(chunk)))
        socket.once("end", () => resolve(reply === "alive"))
        socket.once("error", () => resolve(false))
      }),
  )

const listenIn = (cwd: string) =>
  Effect.promise(
    () =>
      new Promise<{
        readonly pid: number
        readonly exited: Effect.Effect<void>
        readonly answers: Effect.Effect<boolean>
      }>((resolve, reject) => {
        const shell = spawn("sh", ["-c", `"$0" -e "$1" &`, process.execPath, LISTENER], {
          cwd,
          stdio: ["ignore", "pipe", "inherit"],
        })
        const closed = new Promise<void>((done) => shell.stdout.once("close", done))
        shell.once("error", reject)
        shell.stdout.once("data", (chunk) => {
          const [pid, port] = String(chunk).trim().split(" ").map(Number)
          listenerPids.push(pid!)
          resolve({ pid: pid!, exited: Effect.promise(() => closed), answers: answersOn(port!) })
        })
      }),
  )

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterAll(() => listenerPids.filter(isAlive).forEach((pid) => process.kill(pid, "SIGKILL")))

const base = realpathSync(mkdtempSync(join(tmpdir(), "kk-auto-archive-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const domain = threadsLayer.pipe(
  Layer.provideMerge(Scratch.layer(mkdtempSync(join(tmpdir(), "kk-scratch-")))),
  Layer.provideMerge(Terminals.layer),
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(Projects.layer),
  Layer.provide(AgentAccounts.layer),
  Layer.provideMerge(settingsLayer(mkdtempSync(join(tmpdir(), "kk-auto-settle-settings-")))),
)
const testLayer = settleLayer.pipe(
  Layer.provideMerge(pullRequestsLayer),
  Layer.provideMerge(domain),
  Layer.provide(Layer.mergeAll(Git.layer, gitHub, agentRunner, recordingPorts)),
  Layer.provide(Layer.succeed(Events, { publish: (event) => Effect.sync(() => void pushes.push(event)) })),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

const archiveSettings = (patch: Partial<ArchiveSettings>): ArchiveSettings => ({
  whenMerged: false,
  removeWorktree: false,
  settleAfterIdleDays: null,
  archiveAfterSettledDays: null,
  ...patch,
})

const pullRequestUrl = (name: string, index = 0) => `https://github.com/o/${name}/pull/${index + 1}`

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
const isSettled = (id: string) =>
  Threads.use((threads) => threads.get(id)).pipe(Effect.map((thread) => thread.settledAt !== null))

describe("Settle", () => {
  layer(testLayer)((it) => {
    it.effect("leaves every thread alone while the setting is off", () =>
      Effect.gen(function* () {
        yield* Settings.use((settings) =>
          settings.set({ archive: archiveSettings({ whenMerged: false, removeWorktree: false }) }),
        )
        const merged = yield* threadWithPullRequests("off", ["merged"])
        yield* Settle.use((settle) => settle.sweep)
        expect(yield* isSettled(merged)).toBe(false)
      }),
    )

    it.effect("settles a thread once its pull request merges, not when one only closes", () =>
      Effect.gen(function* () {
        yield* Settings.use((settings) =>
          settings.set({ archive: archiveSettings({ whenMerged: true, removeWorktree: false }) }),
        )
        const allMerged = yield* threadWithPullRequests("all", ["merged", "closed"])
        const oneOpen = yield* threadWithPullRequests("some", ["merged", "open"])
        const closed = yield* threadWithPullRequests("closed", ["closed"])
        const running = yield* threadWithPullRequests("running", ["merged"], "running")
        const unlinked = (yield* seedThread({ rootPath: "/unlinked" })).threadId

        yield* Settle.use((settle) => settle.sweep)

        expect(yield* statusOf(allMerged)).toBe("idle")
        expect(yield* isSettled(allMerged)).toBe(true)
        expect(yield* isSettled(oneOpen)).toBe(false)
        expect(yield* isSettled(closed)).toBe(false)
        expect(yield* statusOf(running)).toBe("running")
        expect(yield* isSettled(running)).toBe(false)
        expect(yield* isSettled(unlinked)).toBe(false)
        expect(pushes).toContainEqual(
          expect.objectContaining({ type: "thread.updated", thread: expect.objectContaining({ id: allMerged }) }),
        )
      }),
    )

    it.effect("does not settle a thread again for a merge from before its latest work", () =>
      Effect.gen(function* () {
        yield* Settings.use((settings) =>
          settings.set({ archive: archiveSettings({ whenMerged: true, removeWorktree: false }) }),
        )
        const threadId = yield* threadWithPullRequests("reopened", ["merged"])
        yield* Settle.use((settle) => settle.sweep)
        expect(yield* isSettled(threadId)).toBe(true)

        yield* Threads.use((threads) => threads.unsettle(threadId))
        const reopenedAt = yield* Threads.use((threads) => threads.workStartedAt(threadId))
        mergedAts.set(pullRequestUrl("reopened"), new Date(Date.parse(reopenedAt ?? "") - 1000).toISOString())
        yield* Settle.use((settle) => settle.sweep)
        expect(yield* isSettled(threadId)).toBe(false)
      }),
    )

    it.effect("keeps a pinned thread out of Settled", () =>
      Effect.gen(function* () {
        yield* Settings.use((settings) =>
          settings.set({ archive: archiveSettings({ whenMerged: true, removeWorktree: false }) }),
        )
        const threadId = yield* threadWithPullRequests("pinned", ["merged"])
        yield* Threads.use((threads) => threads.update({ id: threadId, pinned: true }))
        yield* Settle.use((settle) => settle.sweep)
        expect(yield* isSettled(threadId)).toBe(false)
      }),
    )

    for (const [name, act] of [
      ["pin", (id: string) => Threads.use((threads) => threads.update({ id, pinned: true }))],
      ["reopen", (id: string) => Threads.use((threads) => threads.unsettle(id))],
    ] as const) {
      it.effect(`does not undo a ${name} that landed while GitHub was answering`, () =>
        Effect.gen(function* () {
          yield* Settings.use((settings) =>
            settings.set({ archive: archiveSettings({ whenMerged: true, removeWorktree: false }) }),
          )
          const title = `raced-${name}`
          const threadId = yield* threadWithPullRequests(title, ["merged"])
          mergedAts.set(pullRequestUrl(title), new Date(0).toISOString())
          const hold = { asked: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
          held.set(pullRequestUrl(title), hold)
          const sweep = yield* Settle.use((settle) => settle.sweep).pipe(Effect.forkChild)
          yield* Deferred.await(hold.asked)
          yield* act(threadId)
          yield* Deferred.succeed(hold.release, undefined)
          yield* Fiber.join(sweep)
          expect(yield* isSettled(threadId)).toBe(false)
        }),
      )
    }

    it.effect("settles a thread whose pull request merged during its turn", () =>
      Effect.gen(function* () {
        yield* Settings.use((settings) =>
          settings.set({ archive: archiveSettings({ whenMerged: true, removeWorktree: false }) }),
        )
        const threadId = yield* threadWithPullRequests("merged-in-turn", ["merged"])
        yield* Threads.use((threads) => threads.update({ id: threadId, status: "running" }))
        const startedAt = yield* Threads.use((threads) => threads.workStartedAt(threadId))
        mergedAts.set(pullRequestUrl("merged-in-turn"), new Date(Date.parse(startedAt ?? "") + 1000).toISOString())
        yield* Threads.use((threads) => threads.update({ id: threadId, status: "idle" }))
        yield* Settle.use((settle) => settle.sweep)
        expect(yield* isSettled(threadId)).toBe(true)
      }),
    )

    for (const status of ["running", "awaiting_approval"] as const) {
      it.effect(`leaves a thread alone when it went ${status} while GitHub was answering`, () =>
        Effect.gen(function* () {
          yield* Settings.use((settings) =>
            settings.set({ archive: archiveSettings({ whenMerged: true, removeWorktree: false }) }),
          )
          const name = `raced-${status}`
          const threadId = yield* threadWithPullRequests(name, ["merged"])
          const hold = { asked: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
          held.set(pullRequestUrl(name), hold)
          const terminal = yield* Terminals.Terminals.use((terminals) =>
            terminals.open({ threadId, cols: 80, rows: 24 }),
          )

          const sweep = yield* Settle.use((settle) => settle.sweep).pipe(Effect.forkChild)
          yield* Deferred.await(hold.asked)
          yield* Threads.use((threads) => threads.update({ id: threadId, status }))
          yield* Deferred.succeed(hold.release, undefined)
          yield* Fiber.join(sweep)

          expect(yield* statusOf(threadId)).toBe(status)
          expect(yield* Terminals.Terminals.use((terminals) => terminals.list(threadId))).toStrictEqual([terminal])
          expect(yield* isSettled(threadId)).toBe(false)
          yield* Terminals.Terminals.use((terminals) => terminals.close(terminal.id))
        }),
      )
    }

    it.effect("stops the listener, terminals and agent work of a thread the developer settles", () =>
      Effect.gen(function* () {
        const threadId = yield* threadWithPullRequests("manual", ["open"])
        const listener = yield* listenIn(join(base, "manual"))
        yield* Terminals.Terminals.use((terminals) => terminals.open({ threadId, cols: 80, rows: 24 }))

        const settled = yield* Settle.use((settle) => settle.settle(threadId))

        expect(settled.settledAt).not.toBeNull()
        expect(released).toContain(threadId)
        expect(yield* Terminals.Terminals.use((terminals) => terminals.list(threadId))).toStrictEqual([])
        yield* listener.exited
      }),
    )

    it.effect("refuses to settle a thread mid-turn and leaves its work running", () =>
      Effect.gen(function* () {
        const threadId = yield* threadWithPullRequests("manual-busy", ["open"], "running")

        const error = yield* Settle.use((settle) => settle.settle(threadId)).pipe(Effect.flip)

        expect(error._tag).toBe("ThreadBusyError")
        expect(released).not.toContain(threadId)
      }),
    )

    it.effect("leaves the listener and terminals of a thread whose turn starts while it settles", () =>
      Effect.gen(function* () {
        const threadId = yield* threadWithPullRequests("manual-race", ["open"])
        const listener = yield* listenIn(join(base, "manual-race"))
        yield* Terminals.Terminals.use((terminals) => terminals.open({ threadId, cols: 80, rows: 24 }))
        turnStarted.add(threadId)

        const error = yield* Settle.use((settle) => settle.settle(threadId)).pipe(Effect.flip)

        expect(error._tag).toBe("ThreadBusyError")
        expect(yield* Terminals.Terminals.use((terminals) => terminals.list(threadId))).toHaveLength(1)
        expect(isAlive(listener.pid)).toBe(true)
      }),
    )

    it.effect("keeps a merged thread whose ports could not be listed out of Settled", () =>
      Effect.gen(function* () {
        yield* Settings.use((settings) => settings.set({ archive: archiveSettings({ whenMerged: true }) }))
        const threadId = yield* threadWithPullRequests("merged-unknown-ports", ["merged"])
        failingScans.add(threadId)

        yield* Settle.use((settle) => settle.sweep)

        expect(yield* isSettled(threadId)).toBe(false)
      }),
    )

    it.effect("settles a thread idle for the configured days, unless one of its pull requests is open", () =>
      Effect.gen(function* () {
        yield* Settings.use((settings) => settings.set({ archive: archiveSettings({ settleAfterIdleDays: 7 }) }))
        const quiet = (yield* seedThread({ rootPath: "/idle-quiet" })).threadId
        const reviewing = yield* threadWithPullRequests("idle-reviewing", ["open"])
        yield* TestClock.setTime(Date.parse((yield* Threads.use((threads) => threads.get(reviewing))).updatedAt))

        yield* TestClock.adjust("6 days")
        yield* Settle.use((settle) => settle.sweep)
        expect(yield* isSettled(quiet)).toBe(false)

        yield* TestClock.adjust("1 day")
        yield* Settle.use((settle) => settle.sweep)
        expect(yield* isSettled(quiet)).toBe(true)
        expect(released).toContain(quiet)
        expect(yield* isSettled(reviewing)).toBe(false)
      }),
    )

    it.effect("keeps a pin that lands while the idle pass releases the thread", () =>
      Effect.gen(function* () {
        yield* Settings.use((settings) => settings.set({ archive: archiveSettings({ settleAfterIdleDays: 7 }) }))
        const { threadId } = yield* seedThread({ rootPath: "/idle-pinned" })
        yield* TestClock.setTime(Date.parse((yield* Threads.use((threads) => threads.get(threadId))).updatedAt))
        yield* TestClock.adjust("7 days")
        const hold = { asked: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
        heldReleases.set(threadId, hold)

        const sweeping = yield* Settle.use((settle) => settle.sweep).pipe(Effect.forkChild)
        yield* Deferred.await(hold.asked)
        yield* Threads.use((threads) => threads.update({ id: threadId, pinned: true }))
        yield* Deferred.succeed(hold.release, undefined)
        yield* Fiber.join(sweeping)

        const thread = yield* Threads.use((threads) => threads.get(threadId))
        expect(thread.pinnedAt).not.toBeNull()
        expect(thread.settledAt).toBeNull()
      }),
    )

    it.effect("archives a thread once it has been settled for the configured days", () =>
      Effect.gen(function* () {
        const { threadId } = yield* seedThread({ rootPath: "/archive-later" })
        yield* TestClock.setTime(Date.parse((yield* Threads.use((threads) => threads.get(threadId))).updatedAt))
        yield* Settle.use((settle) => settle.settle(threadId))
        yield* Settings.use((settings) => settings.set({ archive: archiveSettings({ archiveAfterSettledDays: 3 }) }))

        yield* TestClock.adjust("2 days")
        yield* Settle.use((settle) => settle.sweep)
        expect(yield* statusOf(threadId)).toBe("idle")

        yield* TestClock.adjust("1 day")
        yield* Settle.use((settle) => settle.sweep)
        expect(yield* statusOf(threadId)).toBe("archived")
      }),
    )

    it.effect("keeps a settled thread when auto archive is turned off while the sweep releases it", () =>
      Effect.gen(function* () {
        const { threadId } = yield* seedThread({ rootPath: "/archive-turned-off" })
        yield* TestClock.setTime(Date.parse((yield* Threads.use((threads) => threads.get(threadId))).updatedAt))
        yield* Settle.use((settle) => settle.settle(threadId))
        yield* Settings.use((settings) => settings.set({ archive: archiveSettings({ archiveAfterSettledDays: 1 }) }))
        yield* TestClock.adjust("1 day")
        const hold = { asked: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
        heldReleases.set(threadId, hold)

        const sweeping = yield* Settle.use((settle) => settle.sweep).pipe(Effect.forkChild)
        yield* Deferred.await(hold.asked)
        yield* Settings.use((settings) => settings.set({ archive: archiveSettings({ archiveAfterSettledDays: null }) }))
        yield* Deferred.succeed(hold.release, undefined)
        yield* Fiber.join(sweeping)

        expect(yield* statusOf(threadId)).toBe("idle")
      }),
    )

    it.effect("waits for a merged thread's background tasks, sub-agents and listeners before it settles", () =>
      Effect.gen(function* () {
        yield* Settings.use((settings) =>
          settings.set({ archive: archiveSettings({ whenMerged: true, removeWorktree: false }) }),
        )
        const threadId = yield* threadWithPullRequests("quiet", ["merged"])
        const staysReady = Effect.gen(function* () {
          yield* Settle.use((settle) => settle.sweep)
          expect(yield* isSettled(threadId)).toBe(false)
        })

        backgroundTasks.set(threadId, [{ id: "shell", kind: "shell", label: "pnpm dev", startedAt: "" }])
        yield* staysReady
        backgroundTasks.delete(threadId)

        subagents.set(threadId, [{ id: "survey", status: "running" } as Subagent])
        yield* staysReady
        subagents.delete(threadId)

        const listener = yield* listenIn(join(base, "quiet"))
        yield* staysReady
        process.kill(listener.pid)
        yield* listener.exited

        expect(released).not.toContain(threadId)

        yield* Settle.use((settle) => settle.sweep)

        expect(yield* isSettled(threadId)).toBe(true)
        expect(released).toContain(threadId)
      }),
    )
  })
})

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" })

const localBranches = (root: string) =>
  git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).toSorted()

const watchUnlessMissing = (folder: string, listener: () => void) => {
  try {
    return watch(folder, listener)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

const waitUntilGone = (path: string) =>
  Effect.callback<void>((resume) => {
    let done = false
    const check = () => {
      if (done || existsSync(path)) return
      done = true
      watcher?.close()
      resume(Effect.void)
    }
    const watcher = watchUnlessMissing(dirname(path), check)
    check()
    return Effect.sync(() => watcher?.close())
  })

const waitUntilBranchGone = (root: string, branch: string) => waitUntilGone(join(root, ".git", "refs", "heads", branch))

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

const sweep = Settle.use((settle) => settle.sweep)

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
    const cleanupOn = Settings.use((settings) =>
      settings.set({ archive: archiveSettings({ whenMerged: true, removeWorktree: true }) }),
    )

    it.effect("keeps a settled thread whose worktree has uncommitted changes out of auto archive", () =>
      Effect.gen(function* () {
        const { projectId } = yield* project("dirty-archive")
        const thread = yield* worktreeThread(projectId, "kk/dirty-archive")
        yield* Settle.use((settle) => settle.settle(thread.threadId))
        yield* Settings.use((settings) =>
          settings.set({ archive: archiveSettings({ removeWorktree: true, archiveAfterSettledDays: 1 }) }),
        )
        const scratchFile = join(thread.path, "notes.txt")
        writeFileSync(scratchFile, "work in progress")

        yield* TestClock.adjust("1 day")
        yield* sweep
        expect(yield* statusOf(thread.threadId)).toBe("idle")

        unlinkSync(scratchFile)
        yield* sweep
        expect(yield* statusOf(thread.threadId)).toBe("archived")
        yield* waitUntilGone(thread.path)
      }),
    )

    it.effect("leaves a project root listener running when a merge removes a thread's worktree", () =>
      Effect.gen(function* () {
        yield* cleanupOn
        const { root, projectId } = yield* project("root-listener")
        const rootListener = yield* listenIn(root)
        const child = yield* worktreeThread(projectId, "kk/root-listener")
        yield* linkPullRequest(child, "kk/root-listener", "merged")

        yield* sweep

        expect(yield* isSettled(child.threadId)).toBe(true)
        yield* waitUntilGone(child.path)
        expect(portsClosedFor).not.toContain(child.threadId)
        expect(isAlive(rootListener.pid)).toBe(true)
      }),
    )

    it.effect("leaves a project root listener running when the developer settles a thread whose worktree is gone", () =>
      Effect.gen(function* () {
        const { root, projectId } = yield* project("removed-worktree")
        const rootListener = yield* listenIn(root)
        const child = yield* worktreeThread(projectId, "kk/removed-worktree")
        const { worktreeId } = yield* Threads.use((threads) => threads.get(child.threadId))
        yield* Worktrees.Worktrees.use((worktrees) => worktrees.remove(worktreeId!, "keep"))

        yield* Settle.use((settle) => settle.settle(child.threadId))

        expect(yield* isSettled(child.threadId)).toBe(true)
        expect(portsClosedFor).toContain(child.threadId)
        expect(yield* rootListener.answers).toBe(true)
      }),
    )

    it.effect(
      "leaves a project root listener running when auto archive takes a thread whose merge removed its worktree",
      () =>
        Effect.gen(function* () {
          yield* cleanupOn
          const { root, projectId } = yield* project("archive-after-merge")
          const rootListener = yield* listenIn(root)
          const child = yield* worktreeThread(projectId, "kk/archive-after-merge")
          yield* linkPullRequest(child, "kk/archive-after-merge", "merged")
          yield* sweep
          yield* waitUntilGone(child.path)

          yield* Settings.use((settings) =>
            settings.set({ archive: archiveSettings({ removeWorktree: true, archiveAfterSettledDays: 1 }) }),
          )
          yield* TestClock.adjust("1 day")
          yield* sweep

          expect(yield* statusOf(child.threadId)).toBe("archived")
          expect(portsClosedFor).toContain(child.threadId)
          expect(yield* rootListener.answers).toBe(true)
        }),
    )

    it.effect("counts a branch as gone once git pruned its folder", () =>
      Effect.gen(function* () {
        const root = join(base, "pruned-folder")
        execFileSync("git", ["init", "-q", "-b", "main", root])
        git(root, "commit", "-q", "--allow-empty", "-m", "init")
        git(root, "branch", "kk/pruned")
        git(root, "branch", "-D", "kk/pruned")

        expect(existsSync(join(root, ".git", "refs", "heads", "kk"))).toBe(false)
        yield* waitUntilBranchGone(root, "kk/pruned")
      }),
    )

    it.effect("removes a worktree and its squash-merged branch once its pull request merges", () =>
      Effect.gen(function* () {
        yield* cleanupOn
        const { root, projectId } = yield* project("squash")
        const child = yield* worktreeThread(projectId, "kk/child")
        yield* linkPullRequest(child, "kk/child", "merged")

        yield* sweep

        expect(yield* isSettled(child.threadId)).toBe(true)
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

        expect(yield* isSettled(fork.threadId)).toBe(true)
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

        expect(yield* isSettled(child.threadId)).toBe(true)
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

        expect(yield* isSettled(child.threadId)).toBe(true)
        yield* waitUntilGone(child.path)
        yield* expectBranchAt(projectId, "kk/reused", tip)
      }),
    )

    it.effect("leaves a closed pull request to the developer, and archiving keeps its unmerged branch", () =>
      Effect.gen(function* () {
        yield* cleanupOn
        const { root, projectId } = yield* project("closed-pr")
        const child = yield* worktreeThread(projectId, "kk/abandoned")
        yield* linkPullRequest(child, "kk/abandoned", "closed")

        yield* sweep
        expect(yield* statusOf(child.threadId)).toBe("idle")

        yield* Threads.use((threads) => threads.archive(child.threadId))
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

        expect(yield* isSettled(conductor.threadId)).toBe(true)
        expect(yield* statusOf(child.threadId)).toBe("idle")
        yield* waitUntilGone(conductor.path)
        expect(existsSync(child.path)).toBe(true)

        yield* setStatus(childUrl, "merged")
        yield* sweep

        expect(yield* isSettled(child.threadId)).toBe(true)
        yield* waitUntilGone(child.path)
        yield* waitUntilBranchGone(root, "kk/conductor")
        yield* waitUntilBranchGone(root, "kk/worker")
        expect(localBranches(root)).toStrictEqual(["main"])
      }),
    )

    it.effect("settles a finished thread whose worktree an open fork still uses, and the fork removes it later", () =>
      Effect.gen(function* () {
        yield* cleanupOn
        const { projectId } = yield* project("shared")
        const source = yield* worktreeThread(projectId, "kk/shared")
        const fork = yield* Threads.use((threads) =>
          threads.create({ projectId, title: "kk/shared (fork)", provider: "claude", model: "m" }),
        )
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE thread SET worktree_id = (SELECT worktree_id FROM thread WHERE id = ${source.threadId}) WHERE id = ${fork.id}`
        const url = yield* linkPullRequest(source, "kk/shared", "merged")

        yield* sweep

        expect(yield* isSettled(source.threadId)).toBe(true)
        expect(existsSync(source.path)).toBe(true)

        yield* PullRequests.use((pullRequests) => pullRequests.link(fork.id, url))
        yield* sweep

        expect(yield* isSettled(fork.id)).toBe(true)
        yield* waitUntilGone(source.path)
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

          expect(yield* isSettled(threads[second].threadId)).toBe(true)
          yield* waitUntilGone(threads[second].path)
          yield* waitUntilBranchGone(root, "kk/parent")
          yield* waitUntilBranchGone(root, "kk/stacked")
          expect(localBranches(root)).toStrictEqual(["main"])
        }),
      )
    }
  })
})
