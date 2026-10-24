import { useAtomValue } from "@effect/atom-react"
import { useParams, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import type { Environments, EnvironmentStatus, Project } from "../../shared/domain.ts"
import { linearReviewUrl } from "../../shared/github.ts"
import { REMOTE_PROTOCOL_VERSION } from "../../shared/remote.ts"
import { m } from "../paraglide/messages.js"
import { useLocale } from "../stores/locale.ts"
import { useThreads } from "../stores/threads.ts"
import { formatRelativeTime } from "./relativeTime.ts"
import { type EnvironmentId, environmentsAtom, projectsAtom } from "./rpc.ts"
import { useNow } from "./useNow.ts"

export type Cloud = Environments["clouds"][number]

const noClouds: ReadonlyArray<Cloud> = []

/** Paired clouds with their link status. Empty until `environments.list` answers. */
export const useClouds = () =>
  AsyncResult.getOrElse(useAtomValue(environmentsAtom), () => ({ clouds: noClouds })).clouds

/** Where a project lives. Main stamps `environmentId` on every cloud project. */
export const environmentOf = (project: Pick<Project, "environmentId"> | undefined): EnvironmentId =>
  project?.environmentId ?? null

export function useThreadEnvironment(threadId: string | null | undefined): EnvironmentId {
  const projectId = useThreads((state) => (threadId ? state.byId[threadId]?.projectId : undefined))
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => [])
  return environmentOf(projects.find((project) => project.id === projectId))
}

export function useCloud(environment: EnvironmentId): Cloud | undefined {
  return useClouds().find((cloud) => cloud.id === environment)
}

/** A cloud that is not connected still lists its last known projects and threads, which may be out of date. */
export const isStale = (cloud: Cloud | undefined) => cloud !== undefined && cloud.status !== "connected"

export const environmentName = (environment: EnvironmentId, clouds: ReadonlyArray<Cloud>) =>
  environment === null
    ? m.environment_this_machine()
    : (clouds.find((cloud) => cloud.id === environment)?.name ?? environment)

export const cloudAddress = (cloud: Pick<Cloud, "host" | "port">) => `${cloud.host}:${cloud.port}`

export const statusLabel: Record<EnvironmentStatus, () => string> = {
  connecting: m.environment_status_connecting,
  connected: m.environment_status_connected,
  offline: m.environment_status_offline,
  unauthorized: m.environment_status_unauthorized,
  incompatible: m.environment_status_incompatible,
}

export const statusDot: Record<EnvironmentStatus, string> = {
  connecting: "bg-muted-foreground",
  connected: "bg-success",
  offline: "bg-destructive",
  unauthorized: "bg-attention",
  incompatible: "bg-attention",
}

export function useSettingsEnvironment(): EnvironmentId {
  const { environment } = useSearch({ strict: false })
  const clouds = useClouds()
  return clouds.some((cloud) => cloud.id === environment) ? (environment ?? null) : null
}

/** Where the thread in view runs. For views inside the thread route that do not hold the thread themselves. */
export function useOpenThreadEnvironment(): EnvironmentId {
  const { threadId } = useParams({ strict: false })
  return useThreadEnvironment(threadId)
}

/** Which side of an incompatible link to update: the one on the older protocol. */
export const incompatibleText = (cloud: Pick<Cloud, "name" | "protocol">) =>
  cloud.protocol !== undefined && cloud.protocol > REMOTE_PROTOCOL_VERSION
    ? m.environment_update_desktop({ name: cloud.name })
    : m.environment_update_cloud({ name: cloud.name })

/**
 * A cloud's state in words, or null while connected. Offline says when it last answered, and the two states that
 * stop retrying say what to do.
 */
export function useCloudStateText(cloud: Cloud): string | null {
  const now = useNow()
  const locale = useLocale((state) => state.locale)
  switch (cloud.status) {
    case "connected":
      return null
    case "connecting":
      return m.environment_status_connecting()
    case "offline":
      return cloud.lastSeenAt === null
        ? m.environment_status_offline()
        : m.environment_offline_since({ time: formatRelativeTime(cloud.lastSeenAt, now, locale) })
    case "unauthorized":
      return m.environment_pair_again()
    case "incompatible":
      return incompatibleText(cloud)
  }
}

/** Where a pull request link of the thread opens: GitHub, or linear.review when its project turned that on. */
export function usePullRequestHref(threadId: string | null | undefined, url: string): string {
  const projectId = useThreads((state) => (threadId ? state.byId[threadId]?.projectId : undefined))
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => [])
  const linearReview = projects.find((project) => project.id === projectId)?.linearReview ?? false
  return linearReview ? linearReviewUrl(url) : url
}
