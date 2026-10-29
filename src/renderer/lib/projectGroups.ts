import type { Project } from "../../shared/domain.ts"

export interface ProjectGroup {
  readonly key: string
  readonly projects: readonly [Project, ...Array<Project>]
}

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
