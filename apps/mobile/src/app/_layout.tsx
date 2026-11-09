import { DarkTheme, DefaultTheme, enableLegacyHeaderAppearance, Stack, ThemeProvider } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { type ReactNode, useEffect } from "react"
import { Appearance, Platform, StyleSheet, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { ConnectionProvider } from "@/components/connection-provider"
import { largeTitle } from "@/components/glass"
import { Notifier } from "@/components/notifier"
import { ThreadSidebar } from "@/components/thread-sidebar"
import { useSplitLayout } from "@/hooks/use-split-layout"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { usePreferences } from "@/stores/preferences"

// A deep link or a notification opens a thread with the tabs under it, so back has somewhere to go.
export const unstable_settings = { anchor: "(tabs)" }

// Expo Router 58 lays iOS 26 screens under a translucent header. The thread, file and pull request screens put fixed
// content at the top, which would slide under it, so keep the opaque header until they are designed for that.
enableLegacyHeaderAppearance()

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
        <Stack screenOptions={{ headerShadowVisible: false }} screenLayout={SideSafeArea}>
          <Stack.Protected guard={paired}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            {/* Picking a thread in the sidebar swaps the detail, as Mail does, instead of sliding a page in. */}
            <Stack.Screen name="thread/[id]/index" options={{ title: "", animation: split ? "none" : undefined }} />
            <Stack.Screen name="thread/[id]/file" options={{ title: "" }} />
            <Stack.Screen name="thread/[id]/pull-request" options={{ title: "" }} />
            <Stack.Screen name="thread/[id]/subagent" options={{ title: "" }} />
            <Stack.Screen name="thread/[id]/document" options={{ title: "" }} />
            <Stack.Screen
              name="project/new"
              options={{ title: copy("mobile_project_new_title"), presentation: "modal" }}
            />
          </Stack.Protected>
          <Stack.Protected guard={!paired}>
            <Stack.Screen
              name="connect"
              options={{ title: copy("mobile_connect_title"), ...largeTitle }}
            />
          </Stack.Protected>
        </Stack>
      </View>
    </View>
  )
}

/** iPhone Duo's outer display puts the status bar and the header buttons in a column at the side, over the content. */
function SideSafeArea({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView edges={["left", "right"]} style={styles.detail}>
      {children}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  split: { flex: 1, flexDirection: "row" },
  detail: { flex: 1 },
})
