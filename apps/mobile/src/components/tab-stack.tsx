import { Stack } from "expo-router"
import { largeTitle } from "@/components/glass"

export function TabStack({ title }: { title: string }) {
  return (
    <Stack screenOptions={{ headerShadowVisible: false }}>
      <Stack.Screen name="index" options={{ title, ...largeTitle }} />
    </Stack>
  )
}
