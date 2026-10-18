import { create } from "zustand"
import type { PullRequest, PullRequestDetail, PullRequestLink } from "@shared/domain.ts"
import { call } from "@/lib/connection"
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

interface PullRequestsState {
  /** Links per thread, oldest first, so the newest is last. A thread is absent until its links have loaded. */
  readonly linksByThread: Readonly<Record<string, readonly PullRequestLink[]>>
  readonly summaries: Readonly<Record<string, Remote<PullRequestSummary>>>
  readonly pullRequests: Readonly<Record<string, Remote<PullRequest>>>
  readonly details: Readonly<Record<string, Remote<PullRequestDetail>>>
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
}

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
  }
})

/** The pull request number in a GitHub pull request URL, so a link can show `#123` before GitHub answers. */
export const pullRequestNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1] ?? null
