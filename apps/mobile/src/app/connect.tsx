import { useLocalSearchParams } from "expo-router"
import { PairingForm } from "@/components/pairing-form"
import { RelayAccountSection } from "@/components/relay-account"
import { useConnection } from "@/lib/connection"

export default function ConnectScreen() {
  const { pairing } = useLocalSearchParams<{ pairing?: string }>()
  const refused = useConnection((state) => state.servers.find((server) => server.error !== null)?.error ?? null)
  return <PairingForm key={pairing} initial={pairing} refused={refused} footer={<RelayAccountSection />} />
}
