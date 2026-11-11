import type { Project, Thread, ThreadSearchHit } from "@shared/domain.ts"
import { type EnvironmentFilter, shownEnvironmentIds } from "@shared/environmentFilter.ts"
import { filterPickedProjects, groupProjects, type ProjectGroup } from "@shared/projectGroups.ts"
import type { ConnectionStatus } from "./connection"

export function shownServers(
  filter: EnvironmentFilter,
  servers: readonly { readonly id: string; readonly status: ConnectionStatus }[],
): ReadonlySet<string> | null {
  const shown = shownEnvironmentIds(
    filter,
    servers.map((server) => ({ id: server.id, offline: server.status === "offline" })),
  )
  return shown.size === servers.length ? null : shown
}

export interface ThreadFilter {
  readonly servers: ReadonlySet<string> | null
  readonly projectIds: readonly string[]
}

const onShown = (servers: ReadonlySet<string> | null, project: Project | undefined) =>
  servers === null || (project?.environmentId !== undefined && servers.has(project.environmentId))

const shownProjects = (filter: ThreadFilter, projects: readonly Project[]): readonly Project[] =>
  filterPickedProjects(
    projects.filter((project) => onShown(filter.servers, project)),
    filter.projectIds,
  )

export function withinFilter(
  filter: ThreadFilter,
  projects: readonly Project[],
  threads: readonly Thread[],
): { readonly projects: readonly Project[]; readonly threads: readonly Thread[] } {
  const shown = shownProjects(filter, projects)
  if (shown.length === projects.length) return { projects, threads }
  const ids = new Set(shown.map((project) => project.id))
  return { projects: shown, threads: threads.filter((thread) => ids.has(thread.projectId)) }
}

export function hitsWithinFilter(
  filter: ThreadFilter,
  projects: readonly Project[],
  hits: readonly ThreadSearchHit[],
): readonly ThreadSearchHit[] {
  const shown = shownProjects(filter, projects)
  if (shown.length === projects.length) return hits
  const ids = new Set(shown.map((project) => project.id))
  return hits.filter((hit) => ids.has(hit.projectId))
}

export const projectChoices = (servers: ReadonlySet<string> | null, projects: readonly Project[]) =>
  groupProjects(projects).filter((group) => group.projects.some((project) => onShown(servers, project)))

export const pickedGroups = (filter: ThreadFilter, projects: readonly Project[]): readonly ProjectGroup[] =>
  projectChoices(filter.servers, projects).filter((group) =>
    group.projects.some((project) => onShown(filter.servers, project) && filter.projectIds.includes(project.id)),
  )
