import { parsePairingUrl } from "@shared/remote.ts"
import { useConnection } from "@/lib/connection"
import { codeFromCallback } from "@/lib/relay-account"

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (parsePairingUrl(path) !== null && useConnection.getState().paired) return null
  if (codeFromCallback(path) !== null) return null
  return path
}
