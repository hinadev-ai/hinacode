import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useEffect } from "react"
import { Appearance, Platform, StyleSheet, View } from "react-native"
import { ConnectionProvider } from "@/components/connection-provider"
import { Notifier } from "@/components/notifier"
import { ThreadSidebar } from "@/components/thread-sidebar"
import { useSplitLayout } from "@/hooks/use-split-layout"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { usePreferences } from "@/stores/preferences"

// A deep link or a notification opens a thread with the list under it, so back has somewhere to go.
export const unstable_settings = { initialRouteName: "index" }

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
  const paired = useConnection((state) => state.paired)
  const split = useSplitLayout() && paired
  // The Stack keeps its place in the tree whether the sidebar shows or not, so a resize keeps the navigation state.
  return (
    <View style={styles.split}>
      {split && <ThreadSidebar />}
      <View style={styles.detail}>
        <Stack screenOptions={{ headerShadowVisible: false }}>
          <Stack.Protected guard={paired}>
            <Stack.Screen name="index" options={{ title: copy("mobile_home_title") }} />
            {/* Picking a thread in the sidebar swaps the detail, as Mail does, instead of sliding a page in. */}
            <Stack.Screen name="thread/[id]/index" options={{ title: "", animation: split ? "none" : undefined }} />
            <Stack.Screen name="thread/[id]/file" options={{ title: "" }} />
            <Stack.Screen name="thread/[id]/pull-request" options={{ title: "" }} />
            <Stack.Screen name="settings" options={{ title: copy("mobile_settings_title") }} />
            <Stack.Screen
              name="project/new"
              options={{ title: copy("mobile_project_new_title"), presentation: "modal" }}
            />
          </Stack.Protected>
          <Stack.Protected guard={!paired}>
            <Stack.Screen name="connect" options={{ title: copy("mobile_connect_title") }} />
          </Stack.Protected>
        </Stack>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  split: { flex: 1, flexDirection: "row" },
  detail: { flex: 1 },
})
