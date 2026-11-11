import { type Server, useConnection } from "@/lib/connection"
import { shownServers, type ThreadFilter } from "@/lib/thread-filter"
import { usePreferences } from "@/stores/preferences"
import { useThreads } from "@/stores/threads"

export function useProjectServer(projectId: string | undefined): Server | undefined {
  const serverId = useThreads((state) => state.projects.find((project) => project.id === projectId)?.environmentId)
  return useConnection((state) => state.servers.find((server) => server.id === serverId))
}

export function useThreadServer(threadId: string): Server | undefined {
  const projectId = useThreads((state) => state.byId[threadId]?.projectId)
  return useProjectServer(projectId)
}

export function useThreadConnection(threadId: string) {
  const server = useThreadServer(threadId)
  const any = useConnection((state) => state.status)
  return server?.status ?? any
}

export const serverName = (server: Pick<Server, "name" | "hosts">) => server.name ?? server.hosts[0]

export const useSeveralServers = () => useConnection((state) => state.servers.length > 1)

export function useShownServers(): ReadonlySet<string> | null {
  const servers = useConnection((state) => state.servers)
  const filter = usePreferences((state) => state.environmentFilter)
  return shownServers(filter, servers)
}

export function useThreadFilter(): ThreadFilter {
  const servers = useShownServers()
  const projectIds = usePreferences((state) => state.projectIds)
  return { servers, projectIds }
}
