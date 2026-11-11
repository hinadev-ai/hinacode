import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { create } from "zustand"
import type { Environments, Project, PullRequestLink } from "../../shared/domain.ts"
import { call, projectsAtom } from "../lib/rpc.ts"
import { selectThread, useThreads } from "./threads.ts"

interface PullRequestsState {
  readonly byThreadId: Readonly<Record<string, ReadonlyArray<PullRequestLink>>>
  readonly replace: (threadId: string, links: ReadonlyArray<PullRequestLink>) => void
  readonly replaceAll: (links: ReadonlyArray<PullRequestLink>, keeps: (threadId: string) => boolean) => void
}

export const usePullRequests = create<PullRequestsState>()((set) => ({
  byThreadId: {},
  replace: (threadId, links) => set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: links } })),
  replaceAll: (links, keeps) =>
    set((state) => {
      const kept = Object.fromEntries(Object.entries(state.byThreadId).filter(([threadId]) => keeps(threadId)))
      const loaded: Record<string, Array<PullRequestLink>> = {}
      for (const link of links) (loaded[link.threadId] ??= []).push(link)
      return { byThreadId: { ...kept, ...loaded } }
    }),
}))

const onUnreachableCloud = (clouds: Environments["clouds"], projects: ReadonlyArray<Project>) => {
  const unreachable = new Set(clouds.filter((cloud) => cloud.status !== "connected").map((cloud) => cloud.id))
  const projectIds = new Set(
    projects.filter((project) => unreachable.has(project.environmentId ?? "")).map((project) => project.id),
  )
  const threads = useThreads.getState()
  return (threadId: string) => projectIds.has(selectThread(threadId)(threads)?.projectId ?? "")
}

export const loadAllPullRequestsAtom = Atom.make((get) =>
  Effect.all([call("pullRequests.all", undefined), call("environments.list", undefined)], {
    concurrency: "unbounded",
  }).pipe(
    Effect.tap(([links, { clouds }]) =>
      Effect.sync(() => {
        const projects = AsyncResult.getOrElse(get.once(projectsAtom), (): ReadonlyArray<Project> => [])
        usePullRequests.getState().replaceAll(links, onUnreachableCloud(clouds, projects))
      }),
    ),
    Effect.asVoid,
  ),
).pipe(Atom.keepAlive)

export const loadPullRequestsAtom = Atom.family((threadId: string) =>
  Atom.make(
    call("pullRequests.list", { threadId }).pipe(
      Effect.tap((links) => Effect.sync(() => usePullRequests.getState().replace(threadId, links))),
      Effect.asVoid,
    ),
  ),
)
