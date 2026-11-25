import { useAtomValue } from "@effect/atom-react"
import { useParams, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import type { Environments, EnvironmentStatus, Project } from "../../shared/domain.ts"
import { linearReviewUrl } from "../../shared/github.ts"
import { REMOTE_PROTOCOL_VERSION } from "../../shared/remote.ts"
import { m } from "../paraglide/messages.js"
import { useLocale } from "../stores/locale.ts"
import { selectThread, useThreads } from "../stores/threads.ts"
import { formatRelativeTime } from "./relativeTime.ts"
import { type EnvironmentId, environmentsAtom, projectsAtom } from "./rpc.ts"
import { useNow } from "./useNow.ts"
import { inBrowser } from "./runtime.ts"

export type Cloud = Environments["clouds"][number]

const noClouds: ReadonlyArray<Cloud> = []

export const useClouds = () =>
  AsyncResult.getOrElse(useAtomValue(environmentsAtom), () => ({ clouds: noClouds })).clouds

export const environmentOf = (project: Pick<Project, "environmentId"> | undefined): EnvironmentId =>
  project?.environmentId ?? null

export function useThreadEnvironment(threadId: string | null | undefined): EnvironmentId {
  const projectId = useThreads((state) => (threadId ? selectThread(threadId)(state)?.projectId : undefined))
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => [])
  return environmentOf(projects.find((project) => project.id === projectId))
}

export function useCloud(environment: EnvironmentId): Cloud | undefined {
  return useClouds().find((cloud) => cloud.id === environment)
}

export const isStale = (cloud: Cloud | undefined) => cloud !== undefined && cloud.status !== "connected"

export const environmentName = (environment: EnvironmentId, clouds: ReadonlyArray<Cloud>) =>
  environment === null
    ? m.environment_this_machine()
    : (clouds.find((cloud) => cloud.id === environment)?.name ?? environment)

export const cloudAddress = (cloud: Pick<Cloud, "host" | "port">) => `${cloud.host}:${cloud.port}`

export const statusLabel: Record<EnvironmentStatus, () => string> = {
  connecting: m.environment_status_connecting,
  approval: m.environment_status_approval,
  connected: m.environment_status_connected,
  offline: m.environment_status_offline,
  unauthorized: m.environment_status_unauthorized,
  incompatible: m.environment_status_incompatible,
}

export const statusDot: Record<EnvironmentStatus, string> = {
  connecting: "bg-muted-foreground",
  approval: "bg-attention",
  connected: "bg-success",
  offline: "bg-destructive",
  unauthorized: "bg-attention",
  incompatible: "bg-attention",
}

export function useSettingsEnvironment(): EnvironmentId {
  const { environment } = useSearch({ strict: false })
  const clouds = useClouds()
  if (clouds.some((cloud) => cloud.id === environment)) return environment ?? null
  return inBrowser() ? (clouds[0]?.id ?? null) : null
}

export function useOpenThreadEnvironment(): EnvironmentId {
  const { threadId } = useParams({ strict: false })
  return useThreadEnvironment(threadId)
}

export const needsYou = (cloud: Pick<Cloud, "status">) =>
  cloud.status === "unauthorized" || cloud.status === "incompatible" || cloud.status === "approval"

export const approvalText = ({ name, approval }: Pick<Cloud, "name" | "approval">) =>
  approval?.accepted
    ? m.environment_confirm_host({ name })
    : m.environment_enter_code({ name, code: approval?.code ?? "" })

export const refusalText = ({ name, refusal }: Pick<Cloud, "name" | "refusal">) => {
  switch (refusal) {
    case "removed":
      return m.environment_refusal_removed({ name })
    case "reset":
      return m.environment_refusal_reset({ name })
    case "predates":
      return m.environment_refusal_predates({ name })
    default:
      return m.environment_refusal_refused({ name })
  }
}

export const repairsFromRelay = (cloud: Pick<Cloud, "status" | "source" | "refusal">) =>
  cloud.status === "unauthorized" && cloud.source === "relay" && cloud.refusal !== undefined

export const incompatibleText = (cloud: Pick<Cloud, "name" | "protocol">) =>
  cloud.protocol !== undefined && cloud.protocol > REMOTE_PROTOCOL_VERSION
    ? m.environment_update_desktop({ name: cloud.name })
    : m.environment_update_cloud({ name: cloud.name })

export function useCloudStateText(cloud: Cloud): string | null {
  const now = useNow()
  const locale = useLocale((state) => state.locale)
  switch (cloud.status) {
    case "connected":
      return null
    case "connecting":
      return m.environment_status_connecting()
    case "approval":
      return approvalText(cloud)
    case "offline":
      return cloud.lastSeenAt === null
        ? m.environment_status_offline()
        : m.environment_offline_since({ time: formatRelativeTime(cloud.lastSeenAt, now, locale) })
    case "unauthorized":
      return refusalText(cloud)
    case "incompatible":
      return incompatibleText(cloud)
  }
}

export function usePullRequestHref(threadId: string | null | undefined, url: string): string {
  const projectId = useThreads((state) => (threadId ? selectThread(threadId)(state)?.projectId : undefined))
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => [])
  const linearReview = projects.find((project) => project.id === projectId)?.linearReview ?? false
  return linearReview ? linearReviewUrl(url) : url
}
