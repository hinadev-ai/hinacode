import { LINK_ORIGIN, parseAppLink } from "@shared/links.ts"
import { useConnection } from "@/lib/connection"
import { routeForLink } from "@/lib/links"
import { peekServers } from "@/lib/storage"

const isOwnLink = (path: string) => parseAppLink(path) !== null || URL.parse(path)?.origin === LINK_ORIGIN

/**
 * Expo Router hands every URL the system opens the app with to this hook, whole and with its fragment, before it
 * matches a route. Other URLs, such as the dev client's, pass through untouched.
 */
export async function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (!isOwnLink(path)) return path
  const restored = useConnection.getState().servers
  // A link that launches the app arrives before ConnectionProvider has restored the servers.
  const servers = initial && restored.length === 0 ? await peekServers() : restored
  return routeForLink(path, {
    paired: servers.length > 0,
    environmentIds: servers.map((server) => server.environmentId),
  })
}
