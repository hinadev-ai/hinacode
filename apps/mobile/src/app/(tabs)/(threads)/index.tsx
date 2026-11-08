import { Stack } from "expo-router"
import { useState } from "react"
import { StyleSheet, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { isIOS, liquidGlass } from "@/components/glass"
import { HomeContent } from "@/components/home"
import { HomeHeaderButtons, HomeToolbar } from "@/components/home-header"
import { FloatingNewThreadAccessory } from "@/components/new-thread-accessory"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { SidebarButton, SidebarToolbarButton } from "@/components/thread-sidebar"
import { Button, EmptyState } from "@/components/ui"
import { useSidebar, useSplitLayout } from "@/hooks/use-split-layout"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

export default function HomeScreen() {
  const theme = useTheme()
  const split = useSplitLayout()
  const [newThreadOpen, setNewThreadOpen] = useState(false)
  const sidebar = useSidebar()

  // In a wide window the list is the sidebar, so this route is the detail side with nothing open yet.
  if (split)
    return (
      <SafeAreaView edges={isIOS ? [] : ["top"]} style={[styles.screen, { backgroundColor: theme.background }]}>
        {isIOS ? (
          <>
            <Stack.Screen options={{ headerShown: true, title: "", headerBackVisible: false }} />
            <SidebarToolbarButton />
          </>
        ) : (
          <>
            <Stack.Screen options={{ headerShown: false }} />
            <View style={styles.header}>
              <SidebarButton />
            </View>
          </>
        )}
        <View style={styles.center}>
          <EmptyState
            icon="Chat"
            title={copy("mobile_home_no_selection")}
            action={
              !sidebar.open && (
                <Button label={copy("mobile_home_show_list")} icon="Sidebar" onPress={sidebar.toggle} />
              )
            }
          />
        </View>
      </SafeAreaView>
    )

  return (
    <>
      <Stack.Screen options={{ headerShown: true, headerRight: isIOS ? undefined : () => <HomeHeaderButtons /> }} />
      {isIOS && <HomeToolbar />}
      <HomeContent />
      {!liquidGlass && (
        <>
          <FloatingNewThreadAccessory onPress={() => setNewThreadOpen(true)} />
          <NewThreadSheet open={newThreadOpen} onClose={() => setNewThreadOpen(false)} />
        </>
      )}
    </>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // Lined up with the thread header, so the sidebar button stays put when a thread opens.
  header: { padding: 4 },
  center: { flex: 1, justifyContent: "center" },
})
