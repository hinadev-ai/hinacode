import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useEffect } from "react"
import { Appearance, Platform } from "react-native"
import { ConnectionProvider } from "@/components/connection-provider"
import { Notifier } from "@/components/notifier"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { usePreferences } from "@/stores/preferences"

export default function RootLayout() {
  const scheme = useScheme()
  const theme = useTheme()
  const appearance = usePreferences((state) => state.appearance)
  const base = scheme === "dark" ? DarkTheme : DefaultTheme

  // Native alerts, switches and the keyboard follow the app's appearance only through this override.
  useEffect(() => {
    if (Platform.OS !== "web") Appearance.setColorScheme(appearance === "system" ? "unspecified" : appearance)
  }, [appearance])

  return (
    <ThemeProvider
      value={{
        ...base,
        colors: {
          ...base.colors,
          primary: theme.primary,
          background: theme.background,
          card: theme.background,
          text: theme.text,
          border: theme.border,
        },
      }}
    >
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <ConnectionProvider>
        <Routes />
        <Notifier />
      </ConnectionProvider>
    </ThemeProvider>
  )
}

function Routes() {
  const paired = useConnection((state) => state.target !== null && state.status !== "unauthorized")
  return (
    <Stack screenOptions={{ headerShadowVisible: false }}>
      <Stack.Protected guard={paired}>
        <Stack.Screen name="index" options={{ title: "Threads" }} />
        <Stack.Screen name="thread/[id]/index" options={{ title: "" }} />
        <Stack.Screen name="thread/[id]/file" options={{ title: "" }} />
        <Stack.Screen name="thread/[id]/pull-request" options={{ title: "" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="project/new" options={{ title: "Add project", presentation: "modal" }} />
      </Stack.Protected>
      <Stack.Protected guard={!paired}>
        <Stack.Screen name="connect" options={{ title: "Pair with desktop" }} />
      </Stack.Protected>
    </Stack>
  )
}
