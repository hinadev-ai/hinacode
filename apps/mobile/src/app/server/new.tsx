import { router, Stack } from "expo-router"
import { PairingForm } from "@/components/pairing-form"
import { copy } from "@/lib/copy"

export default function AddServerScreen() {
  return (
    <>
      <Stack.Screen options={{ title: copy("mobile_server_new_title") }} />
      <PairingForm onPaired={() => (router.canGoBack() ? router.back() : router.replace("/settings"))} />
    </>
  )
}
