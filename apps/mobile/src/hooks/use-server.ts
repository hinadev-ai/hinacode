import { type Server, useConnection } from "@/lib/connection"
import { shownServers } from "@/lib/server-filter"
import { usePreferences } from "@/stores/preferences"
import { useThreads } from "@/stores/threads"

/** The server a project lives on. Every project is stamped with its server's id as it is listed. */
export function useProjectServer(projectId: string | undefined): Server | undefined {
  const serverId = useThreads((state) => state.projects.find((project) => project.id === projectId)?.environmentId)
  return useConnection((state) => state.servers.find((server) => server.id === serverId))
}

/** The server a thread runs on, through its project. */
export function useThreadServer(threadId: string): Server | undefined {
  const projectId = useThreads((state) => state.byId[threadId]?.projectId)
  return useProjectServer(projectId)
}

/** The thread's server's status, or the best of any server's until the thread's project has loaded. */
export function useThreadConnection(threadId: string) {
  const server = useThreadServer(threadId)
  const any = useConnection((state) => state.status)
  return server?.status ?? any
}

/** A server's display name: what it called itself on its first handshake, else the address it was paired at. */
export const serverName = (server: Pick<Server, "name" | "hosts">) => server.name ?? server.hosts[0]

/** More than one server is paired, so lists name the server each thread and project lives on. */
export const useSeveralServers = () => useConnection((state) => state.servers.length > 1)

/** The servers the home list and search show by the developer's filter, or `null` when they show every one. */
export function useShownServers(): ReadonlySet<string> | null {
  const servers = useConnection((state) => state.servers)
  const filter = usePreferences((state) => state.environmentFilter)
  return shownServers(filter, servers)
}
