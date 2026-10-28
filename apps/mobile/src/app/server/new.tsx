import { router, Stack, useLocalSearchParams } from "expo-router"
import { PairingForm } from "@/components/pairing-form"
import { copy } from "@/lib/copy"

/** Pairs one more server, or pairs one again. The new server's status shows in Settings, where this returns. */
export default function AddServerScreen() {
  const { pairing } = useLocalSearchParams<{ pairing?: string }>()
  return (
    <>
      <Stack.Screen options={{ title: copy("mobile_server_new_title") }} />
      <PairingForm
        key={pairing}
        initial={pairing}
        onPaired={() => (router.canGoBack() ? router.back() : router.replace("/settings"))}
      />
    </>
  )
}
