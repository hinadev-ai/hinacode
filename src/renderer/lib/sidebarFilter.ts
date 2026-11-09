import type { Project } from "../../shared/domain.ts"
import { filterPickedProjects } from "../../shared/projectGroups.ts"
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
  return filterPickedProjects(
    projects.filter((project) => !hidden.has(environmentOf(project))),
    projectIds,
  )
}
