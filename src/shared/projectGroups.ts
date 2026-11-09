import type { Project } from "./domain.ts"

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

export function filterPickedProjects<P extends { readonly id: string }>(
  reachable: ReadonlyArray<P>,
  projectIds: ReadonlyArray<string>,
): ReadonlyArray<P> {
  const picked = reachable.filter((project) => projectIds.includes(project.id))
  return picked.length === 0 ? reachable : picked
}

export const isGroupPicked = (group: ProjectGroup, projectIds: ReadonlyArray<string>) =>
  group.projects.every((project) => projectIds.includes(project.id))

export function pickProjectGroup(
  projectIds: ReadonlyArray<string>,
  group: ProjectGroup,
  picked: boolean,
): ReadonlyArray<string> {
  const members = new Set(group.projects.map((project) => project.id))
  const others = projectIds.filter((id) => !members.has(id))
  return picked ? [...others, ...members] : others
}
