import { create } from "zustand"
import type {
  PullRequest,
  PullRequestDetail,
  PullRequestFile,
  PullRequestGuideState,
  PullRequestLink,
} from "@shared/domain.ts"
import { call, onEvent, RpcError } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"

/** A value read from GitHub through the desktop. A refresh keeps the last value until the new one lands. */
export type Remote<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T; readonly at: number }
  | { readonly status: "error"; readonly message: string; readonly at: number }

/** What a thread row needs to color its pull request number. */
export type PullRequestSummary = Pick<PullRequest, "status" | "checks" | "review">

/** Every `github.*` read runs `gh` on the desktop, so a pull request is read at most this often. */
export const SUMMARY_MAX_AGE = 60_000
export const DETAIL_MAX_AGE = 30_000

export type CodeView = "files" | "guide"

interface PullRequestsState {
  /** Links per thread, oldest first, so the newest is last. A thread is absent until its links have loaded. */
  readonly linksByThread: Readonly<Record<string, readonly PullRequestLink[]>>
  readonly summaries: Readonly<Record<string, Remote<PullRequestSummary>>>
  readonly pullRequests: Readonly<Record<string, Remote<PullRequest>>>
  readonly details: Readonly<Record<string, Remote<PullRequestDetail>>>
  /** Changed files per pull request head, see `filesKey`. A push changes the head, so it reads anew. */
  readonly files: Readonly<Record<string, Remote<readonly PullRequestFile[]>>>
  /** Guide state per pull request, kept current by `pullRequest.guide` pushes once read. */
  readonly guides: Readonly<Record<string, Remote<PullRequestGuideState>>>
  /** Whether the Code tab lists files or the guide, kept while the app runs. */
  readonly codeView: CodeView
  /**
   * Reads every thread's links again on each handshake, since pushes were missed while offline. A failure keeps
   * the links already shown; the PRs tab loads and reports its own thread.
   */
  readonly load: () => Promise<void>
  /** Reads one thread's links. Rejects, so the PRs tab can show why. */
  readonly loadThread: (threadId: string) => Promise<void>
  /** A `thread.pullRequests` push: the thread's whole list. */
  readonly replace: (threadId: string, links: readonly PullRequestLink[]) => void
  /** Reads the state of a pull request for a badge, unless a watch snapshot or a recent read already has it. */
  readonly ensureSummary: (url: string) => void
  readonly loadPullRequest: (url: string, options?: { readonly force?: boolean }) => Promise<void>
  readonly loadDetail: (url: string, options?: { readonly force?: boolean }) => Promise<void>
  readonly loadFiles: (url: string, head: string, options?: { readonly force?: boolean }) => Promise<void>
  readonly loadGuide: (url: string, options?: { readonly force?: boolean }) => Promise<void>
  readonly setCodeView: (view: CodeView) => void
}

export const filesKey = (url: string, head: string) => `${url}@${head}`

/** A desktop from before the Code tab answers its methods as unknown, which its schema check reports. */
const codeErrorText = (cause: unknown) =>
  cause instanceof RpcError && cause.tag === "SchemaError" ? copy("mobile_pr_code_update_desktop") : errorText(cause)

const isFresh = (entry: Remote<unknown> | undefined, maxAge: number) =>
  entry !== undefined && (entry.status === "loading" || Date.now() - entry.at < maxAge)

const groupByThread = (links: readonly PullRequestLink[]) => {
  const grouped: Record<string, PullRequestLink[]> = {}
  for (const link of links) (grouped[link.threadId] ??= []).push(link)
  return grouped
}

/** A watched link's last snapshot is a summary the desktop already read, so it costs no `gh` call. */
const snapshotSummaries = (links: readonly PullRequestLink[]) => {
  const summaries: Record<string, Remote<PullRequestSummary>> = {}
  for (const link of links) {
    const snapshot = link.watch?.snapshot
    if (snapshot === null || snapshot === undefined) continue
    const { status, checks, review } = snapshot
    summaries[link.url] = { status: "ready", value: { status, checks, review }, at: Date.now() }
  }
  return summaries
}

export const usePullRequests = create<PullRequestsState>()((set, get) => {
  let pushedDuringLoad: Set<string> | null = null
  /** Bumped by every list a thread receives, so a slower read cannot replace a newer push. */
  const versions = new Map<string, number>()
  const inflight = { pullRequests: new Map<string, Promise<void>>(), details: new Map<string, Promise<void>>() }
  const codeReads = new Map<string, Promise<void>>()

  /** Reads one entry of `files` or `guides` once at a time. A failure keeps a value already shown. */
  function readCode<K extends "files" | "guides", T>(
    slot: K,
    key: string,
    force: boolean,
    read: () => Promise<T>,
  ): Promise<void> {
    const readKey = `${slot}:${key}`
    const pending = codeReads.get(readKey)
    if (pending !== undefined) return pending
    const current = get()[slot][key]
    if (!force && current?.status === "ready") return Promise.resolve()
    const write = (remote: Remote<T>) => set((state) => ({ [slot]: { ...state[slot], [key]: remote } }))
    if (current === undefined) write({ status: "loading" })
    const request = read()
      .then(
        (value) => write({ status: "ready", value, at: Date.now() }),
        (cause: unknown) => {
          if (get()[slot][key]?.status === "ready") return
          write({ status: "error", message: codeErrorText(cause), at: Date.now() })
        },
      )
      .finally(() => codeReads.delete(readKey))
    codeReads.set(readKey, request)
    return request
  }

  // The connection provider routes the other pushes. Only this store reads guides, so it listens itself.
  onEvent((event) => {
    if (event.type !== "pullRequest.guide") return
    set((state) => ({
      guides: { ...state.guides, [event.url]: { status: "ready", value: event.state, at: Date.now() } },
    }))
  })

  const writeSummary = (url: string, summary: Remote<PullRequestSummary>) =>
    set((state) => {
      // A failed read does not hide a summary that a snapshot or an earlier read gave.
      if (summary.status !== "ready" && state.summaries[url]?.status === "ready") return state
      return { summaries: { ...state.summaries, [url]: summary } }
    })

  /** Reads `url` once at a time; a forced read supersedes the one in flight. */
  function fetchInto<T extends PullRequestSummary>(
    key: "pullRequests" | "details",
    url: string,
    read: () => Promise<T>,
  ): Promise<void> {
    const pending = inflight[key]
    const write = (remote: Remote<T>) => set((state) => ({ [key]: { ...state[key], [url]: remote } }))
    if (get()[key][url] === undefined) write({ status: "loading" })
    if (get().summaries[url] === undefined) writeSummary(url, { status: "loading" })
    const request: Promise<void> = read()
      .then(
        (value) => {
          if (pending.get(url) !== request) return
          const at = Date.now()
          const { status, checks, review } = value
          write({ status: "ready", value, at })
          writeSummary(url, { status: "ready", value: { status, checks, review }, at })
        },
        (cause: unknown) => {
          if (pending.get(url) !== request) return
          const failed = { status: "error", message: errorText(cause), at: Date.now() } as const
          write(failed)
          writeSummary(url, failed)
        },
      )
      .finally(() => {
        if (pending.get(url) === request) pending.delete(url)
      })
    pending.set(url, request)
    return request
  }

  return {
    linksByThread: {},
    summaries: {},
    pullRequests: {},
    details: {},
    files: {},
    guides: {},
    codeView: "files",
    load: async () => {
      const ownPushed = new Set<string>()
      pushedDuringLoad = ownPushed
      try {
        const links = await call("pullRequests.all", undefined)
        if (pushedDuringLoad !== ownPushed) return
        set((state) => {
          const linksByThread: Record<string, readonly PullRequestLink[]> = groupByThread(links)
          for (const threadId of ownPushed) {
            const pushed = state.linksByThread[threadId]
            if (pushed !== undefined) linksByThread[threadId] = pushed
          }
          return { linksByThread, summaries: { ...state.summaries, ...snapshotSummaries(links) } }
        })
      } catch {
        return
      } finally {
        if (pushedDuringLoad === ownPushed) pushedDuringLoad = null
      }
    },
    loadThread: async (threadId) => {
      const version = versions.get(threadId)
      const links = await call("pullRequests.list", { threadId })
      if (versions.get(threadId) === version) get().replace(threadId, links)
    },
    replace: (threadId, links) => {
      versions.set(threadId, (versions.get(threadId) ?? 0) + 1)
      pushedDuringLoad?.add(threadId)
      set((state) => ({
        linksByThread: { ...state.linksByThread, [threadId]: links },
        summaries: { ...state.summaries, ...snapshotSummaries(links) },
      }))
    },
    ensureSummary: (url) => {
      const { linksByThread, summaries } = get()
      const watched = Object.values(linksByThread).some((links) =>
        links.some((link) => link.url === url && (link.watch?.snapshot ?? null) !== null),
      )
      if (watched || isFresh(summaries[url], SUMMARY_MAX_AGE)) return
      void get().loadPullRequest(url)
    },
    loadPullRequest: (url, options) => {
      const pending = inflight.pullRequests.get(url)
      if (options?.force !== true) {
        if (pending !== undefined) return pending
        if (isFresh(get().pullRequests[url], SUMMARY_MAX_AGE)) return Promise.resolve()
      }
      return fetchInto("pullRequests", url, () => call("github.pullRequest", { url }))
    },
    loadDetail: (url, options) => {
      const pending = inflight.details.get(url)
      if (options?.force !== true) {
        if (pending !== undefined) return pending
        if (isFresh(get().details[url], DETAIL_MAX_AGE)) return Promise.resolve()
      }
      return fetchInto("details", url, () => call("github.pullRequestDetail", { url }))
    },
    loadFiles: (url, head, options) =>
      readCode("files", filesKey(url, head), options?.force === true, () => call("github.pullRequestFiles", { url })),
    loadGuide: (url, options) =>
      readCode("guides", url, options?.force === true, () => call("pullRequestGuides.get", { url })),
    setCodeView: (codeView) => set({ codeView }),
  }
})

/** The pull request number in a GitHub pull request URL, so a link can show `#123` before GitHub answers. */
export const pullRequestNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1] ?? null
