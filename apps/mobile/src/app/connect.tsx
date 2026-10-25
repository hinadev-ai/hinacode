import { PairingForm } from "@/components/pairing-form"
import { RelayAccountSection } from "@/components/relay-account"
import { useConnection } from "@/lib/connection"

export default function ConnectScreen() {
  const refused = useConnection((state) => state.servers.find((server) => server.error !== null)?.error ?? null)
  return <PairingForm refused={refused} footer={<RelayAccountSection />} />
}
