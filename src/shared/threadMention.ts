import type { Project, Thread } from "./domain.ts"

export const threadMention = (threadId: string) => `@thread:${threadId}`

export const THREAD_MENTION = /@thread:([\w-]+)/g

export const mentionedThreadId = (token: string): string | null => /^@thread:([\w-]+)$/.exec(token)?.[1] ?? null

type MentionThread = Pick<Thread, "id" | "projectId" | "status" | "sortIndex">

export interface MentionableThreads<T> {
  readonly sameMachine: ReadonlyArray<T>
  readonly otherMachines: ReadonlyArray<T>
}

export function mentionableThreads<T extends MentionThread>(
  thread: MentionThread,
  threads: ReadonlyArray<T>,
  projects: ReadonlyArray<Pick<Project, "id" | "environmentId" | "repository">>,
): MentionableThreads<T> {
  const projectsById = new Map(projects.map((project) => [project.id, project]))
  const home = projectsById.get(thread.projectId)
  const isSameRepository = (projectId: string) =>
    projectId === thread.projectId ||
    (home?.repository !== undefined && projectsById.get(projectId)?.repository === home.repository)
  const isSameMachine = (other: T) => projectsById.get(other.projectId)?.environmentId === home?.environmentId
  const candidates = threads.filter(
    (other) => other.id !== thread.id && other.status !== "archived" && isSameRepository(other.projectId),
  )
  // oxlint-disable-next-line unicorn/no-array-sort -- the phone runs this on Hermes, which has no `toSorted`; `filter` made a copy.
  candidates.sort((a, b) => a.sortIndex - b.sortIndex)
  return {
    sameMachine: candidates.filter(isSameMachine),
    otherMachines: candidates.filter((other) => !isSameMachine(other)),
  }
}
