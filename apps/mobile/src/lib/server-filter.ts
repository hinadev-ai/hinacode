import type { Project, Thread, ThreadSearchHit } from "@shared/domain.ts"
import { type EnvironmentFilter, shownEnvironmentIds } from "@shared/environmentFilter.ts"
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

const onShown = (shown: ReadonlySet<string>, project: Project | undefined) =>
  project?.environmentId !== undefined && shown.has(project.environmentId)

/** The projects and threads on the shown servers. */
export function withinServers(
  shown: ReadonlySet<string> | null,
  projects: readonly Project[],
  threads: readonly Thread[],
): { readonly projects: readonly Project[]; readonly threads: readonly Thread[] } {
  if (shown === null) return { projects, threads }
  const kept = projects.filter((project) => onShown(shown, project))
  const ids = new Set(kept.map((project) => project.id))
  return { projects: kept, threads: threads.filter((thread) => ids.has(thread.projectId)) }
}

/** The message hits in projects on the shown servers. */
export function hitsWithinServers(
  shown: ReadonlySet<string> | null,
  projects: readonly Project[],
  hits: readonly ThreadSearchHit[],
): readonly ThreadSearchHit[] {
  if (shown === null) return hits
  const byId = new Map(projects.map((project) => [project.id, project]))
  return hits.filter((hit) => onShown(shown, byId.get(hit.projectId)))
}
