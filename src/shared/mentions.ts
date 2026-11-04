import type { Project, Thread } from "./domain.ts"

export type MentionKind = "thread" | "terminal"

export interface Mention {
  readonly kind: MentionKind
  readonly id: string
}

export const threadMention = (threadId: string) => `@thread:${threadId}`

export const terminalMention = (terminalId: string) => `@terminal:${terminalId}`

export const MENTION = /@(thread|terminal):([\w-]+)/g

const WHOLE_MENTION = /^@(thread|terminal):([\w-]+)$/

export const parseMention = (token: string): Mention | null => {
  const match = WHOLE_MENTION.exec(token)
  return match === null ? null : { kind: match[1] as MentionKind, id: match[2]! }
}

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
  const isSameProject = (other: T) => other.projectId === thread.projectId
  const isSameRepositoryElsewhere = (other: T) => {
    const project = projectsById.get(other.projectId)
    return (
      home?.repository !== undefined &&
      project?.repository === home.repository &&
      project.environmentId !== home.environmentId
    )
  }
  const candidates = threads.filter(
    (other) =>
      other.id !== thread.id &&
      other.status !== "archived" &&
      other.status !== "draft" &&
      (isSameProject(other) || isSameRepositoryElsewhere(other)),
  )
  // oxlint-disable-next-line unicorn/no-array-sort -- the phone runs this on Hermes, which has no `toSorted`; `filter` made a copy.
  candidates.sort((a, b) => a.sortIndex - b.sortIndex)
  return {
    sameMachine: candidates.filter(isSameProject),
    otherMachines: candidates.filter((other) => !isSameProject(other)),
  }
}
