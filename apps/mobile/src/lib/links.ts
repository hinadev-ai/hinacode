import { parseAppLink } from "@shared/links.ts"
import { pairingUrl } from "@shared/remote.ts"

export interface LinkContext {
  /** Whether any server is paired, so a connect link adds a machine instead of making the first pairing. */
  readonly paired: boolean
  /** The machines this phone has paired with. Null for one that has not finished its first handshake. */
  readonly environmentIds: readonly (string | null)[]
}

/**
 * The expo-router href an incoming link or a notification tap goes to. A connect link only fills in the pairing
 * form, so a link from a stranger cannot pair the phone without the developer tapping Connect.
 */
export const routeForLink = (url: string, { paired, environmentIds }: LinkContext): string => {
  const link = parseAppLink(url)
  if (link?.type === "connect") {
    const pairing = encodeURIComponent(pairingUrl(link.target))
    return paired ? `/server/new?pairing=${pairing}` : `/connect?pairing=${pairing}`
  }
  if (link?.type === "thread" && environmentIds.includes(link.environmentId))
    return `/thread/${encodeURIComponent(link.threadId)}`
  return "/"
}
