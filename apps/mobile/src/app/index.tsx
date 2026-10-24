import { Stack } from "expo-router"
import { useState } from "react"
import { StyleSheet, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { HomeActions, HomeContent } from "@/components/home"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { SidebarButton } from "@/components/thread-sidebar"
import { Button, ConnectionBadge, EmptyState } from "@/components/ui"
import { useSidebar, useSplitLayout } from "@/hooks/use-split-layout"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"

export default function HomeScreen() {
  const theme = useTheme()
  const split = useSplitLayout()
  const connection = useConnection((state) => state.status)
  const [newThreadOpen, setNewThreadOpen] = useState(false)
  const sidebar = useSidebar()

  // In a wide window the list is the sidebar, so this route is the detail side with nothing open yet.
  if (split)
    return (
      <SafeAreaView edges={["top"]} style={[styles.screen, { backgroundColor: theme.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <SidebarButton />
        </View>
        <View style={styles.center}>
          <EmptyState
            icon="RiChat1Line"
            title={copy("mobile_home_no_selection")}
            action={
              !sidebar.open && (
                <Button label={copy("mobile_home_show_list")} icon="RiSideBarLine" onPress={sidebar.toggle} />
              )
            }
          />
        </View>
      </SafeAreaView>
    )

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: copy("mobile_home_title"),
          headerLeft:
            connection === "connected"
              ? undefined
              : () => (
                  <View style={styles.headerLeft}>
                    <ConnectionBadge status={connection} />
                  </View>
                ),
          headerRight: () => <HomeActions onNewThread={() => setNewThreadOpen(true)} />,
        }}
      />
      <HomeContent />
      <NewThreadSheet open={newThreadOpen} onClose={() => setNewThreadOpen(false)} />
    </>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // Lined up with the thread header, so the sidebar button stays put when a thread opens.
  header: { padding: 4 },
  center: { flex: 1, justifyContent: "center" },
  headerLeft: { paddingHorizontal: 4 },
})
