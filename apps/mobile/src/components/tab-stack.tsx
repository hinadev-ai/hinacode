import { Stack } from "expo-router"
import { largeTitle } from "@/components/glass"

/** A tab's own stack, so each tab keeps its large title and header items. */
export function TabStack({ title }: { title: string }) {
  return (
    <Stack screenOptions={{ headerShadowVisible: false }}>
      <Stack.Screen name="index" options={{ title, ...largeTitle }} />
    </Stack>
  )
}
