import type { Project, Thread, ThreadSearchHit } from "@shared/domain.ts"
import { type EnvironmentFilter, shownEnvironmentIds } from "@shared/environmentFilter.ts"
import { filterPickedProjects, groupProjects, type ProjectGroup } from "@shared/projectGroups.ts"
import type { ConnectionStatus } from "./connection"

/** The servers the lists show, or `null` when they show everything. */
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

/** What the home list and search narrow to: the shown servers first, then the picked projects on them. */
export interface ThreadFilter {
  /** `null` when every server is shown. */
  readonly servers: ReadonlySet<string> | null
  readonly projectIds: readonly string[]
}

const onShown = (servers: ReadonlySet<string> | null, project: Project | undefined) =>
  servers === null || (project?.environmentId !== undefined && servers.has(project.environmentId))

/** The projects on the shown servers, narrowed to the picked ones among them when any is picked. */
const shownProjects = (filter: ThreadFilter, projects: readonly Project[]): readonly Project[] =>
  filterPickedProjects(
    projects.filter((project) => onShown(filter.servers, project)),
    filter.projectIds,
  )

/** The shown projects and their threads. */
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

/** The message hits in shown projects. */
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

/** The project groups the filter offers: one per repository, for those with a project on a shown server. */
export const projectChoices = (servers: ReadonlySet<string> | null, projects: readonly Project[]) =>
  groupProjects(projects).filter((group) => group.projects.some((project) => onShown(servers, project)))

/** The offered groups the filter narrows to. Empty when it shows every project. */
export const pickedGroups = (filter: ThreadFilter, projects: readonly Project[]): readonly ProjectGroup[] =>
  projectChoices(filter.servers, projects).filter((group) =>
    group.projects.some((project) => onShown(filter.servers, project) && filter.projectIds.includes(project.id)),
  )
