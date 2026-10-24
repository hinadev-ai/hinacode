import { PairingForm } from "@/components/pairing-form"
import { useConnection } from "@/lib/connection"

export default function ConnectScreen() {
  const refused = useConnection((state) => state.servers.find((server) => server.error !== null)?.error ?? null)
  return <PairingForm refused={refused} />
}
