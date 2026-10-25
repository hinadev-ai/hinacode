import type { Project } from "../../shared/domain.ts"

/** Projects that check out the same repository on different machines, listed as one sidebar group. */
export interface ProjectGroup {
  /** The shared `repository`, `chats` for every machine's chats project, or the project id when nothing is shared. */
  readonly key: string
  readonly projects: readonly [Project, ...Array<Project>]
}

/**
 * Groups `projects.list` in its order. A project joins the earlier group with its `repository`, and a chats project
 * joins the other machines' chats, unless that group already holds a project on the same machine, so two clones on
 * one machine stay apart.
 */
export function groupProjects(projects: ReadonlyArray<Project>): ReadonlyArray<ProjectGroup> {
  const groups: Array<{ key: string; projects: [Project, ...Array<Project>] }> = []
  for (const project of projects) {
    const sharedKey = project.kind === "chats" ? "chats" : project.repository
    const shared = groups.find((group) => sharedKey !== undefined && group.key === sharedKey)
    if (shared && shared.projects.every((member) => member.environmentId !== project.environmentId)) {
      shared.projects.push(project)
    } else {
      groups.push({ key: shared ? project.id : (sharedKey ?? project.id), projects: [project] })
    }
  }
  return groups
}
