import type { Project } from "../../shared/domain.ts"

/** Projects that check out the same repository on different machines, listed as one sidebar group. */
export interface ProjectGroup {
  /** The shared `repository`, or the project id when nothing is shared. */
  readonly key: string
  /** At most one project per machine, in list order, so this machine's comes first. */
  readonly projects: readonly [Project, ...Array<Project>]
}

/**
 * Groups `projects.list` in its order. A project joins the earlier group with its `repository` unless that group
 * already holds a project on the same machine, so two clones on one machine stay apart.
 */
export function groupProjects(projects: ReadonlyArray<Project>): ReadonlyArray<ProjectGroup> {
  const groups: Array<{ key: string; projects: [Project, ...Array<Project>] }> = []
  for (const project of projects) {
    const shared = groups.find((group) => project.repository !== undefined && group.key === project.repository)
    if (shared && shared.projects.every((member) => member.environmentId !== project.environmentId)) {
      shared.projects.push(project)
    } else {
      groups.push({ key: shared ? project.id : (project.repository ?? project.id), projects: [project] })
    }
  }
  return groups
}
