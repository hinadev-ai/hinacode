import type { Project } from "../../shared/domain.ts"
import {
  type EnvironmentFilter,
  type FilterableEnvironment,
  shownEnvironmentIds,
} from "../../shared/environmentFilter.ts"
import type { Cloud } from "./environments.ts"
import type { EnvironmentId } from "./rpc.ts"

const environmentOf = (project: Project): EnvironmentId => project.environmentId ?? null

export interface SidebarEnvironment extends FilterableEnvironment<EnvironmentId> {
  readonly cloud: Cloud | undefined
}

export const sidebarEnvironments = (
  projects: ReadonlyArray<Project>,
  clouds: ReadonlyArray<Cloud>,
): ReadonlyArray<SidebarEnvironment> => [
  ...(projects.some((project) => environmentOf(project) === null)
    ? [{ id: null, offline: false, cloud: undefined }]
    : []),
  ...clouds.map((cloud) => ({ id: cloud.id, offline: cloud.status === "offline", cloud })),
]

export const hiddenEnvironmentIds = (
  environments: ReadonlyArray<SidebarEnvironment>,
  filter: EnvironmentFilter,
): ReadonlySet<EnvironmentId> => {
  const shown = shownEnvironmentIds(filter, environments)
  return new Set(environments.map(({ id }) => id).filter((id) => !shown.has(id)))
}

export function filterSidebarProjects(
  projects: ReadonlyArray<Project>,
  hidden: ReadonlySet<EnvironmentId>,
  projectIds: ReadonlyArray<string>,
): ReadonlyArray<Project> {
  const reachable = projects.filter((project) => !hidden.has(environmentOf(project)))
  const picked = reachable.filter((project) => projectIds.includes(project.id))
  return picked.length === 0 ? reachable : picked
}
