import { LINK_ORIGIN, type PairingTarget, pairingParams, parsePairingUrl } from "./remote.ts"

export { LINK_ORIGIN }

export type AppLink =
  | { readonly type: "connect"; readonly target: PairingTarget }
  | { readonly type: "thread"; readonly environmentId: string; readonly threadId: string }

/** The pairing link the QR code carries. The token sits in the fragment, which browsers never send to the relay. */
export const connectLink = (target: PairingTarget) => `${LINK_ORIGIN}/connect#${pairingParams(target)}`

/** Opens a thread on a phone paired with its machine. The ids are not secrets, so they sit in the path. */
export const threadLink = (environmentId: string, threadId: string) =>
  `${LINK_ORIGIN}/t/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`

const decode = (segment: string) => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

const threadOf = (url: URL): AppLink | null => {
  const match = /^\/t\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (url.origin !== LINK_ORIGIN || match === null) return null
  const environmentId = decode(match[1]!)
  const threadId = decode(match[2]!)
  return environmentId === null || threadId === null ? null : { type: "thread", environmentId, threadId }
}

/** Reads a link the app opens, including the older `hinacode://connect?...` pairing URLs. Null for anything else. */
export const parseAppLink = (text: string): AppLink | null => {
  const url = URL.parse(text.trim())
  if (url === null) return null
  const target = parsePairingUrl(url.href)
  return target === null ? threadOf(url) : { type: "connect", target }
}
