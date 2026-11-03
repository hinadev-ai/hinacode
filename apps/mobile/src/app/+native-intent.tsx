import { parsePairingUrl } from "@shared/remote.ts"
import { useConnection } from "@/lib/connection"

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (parsePairingUrl(path) !== null && useConnection.getState().paired) return null
  return path
}
