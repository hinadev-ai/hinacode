import { Stack } from "expo-router"
import { useState } from "react"
import { StyleSheet, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { isIOS } from "@/components/glass"
import { HomeContent } from "@/components/home"
import { HomeHeaderButtons, HomeToolbar } from "@/components/home-header"
import { NewThreadButton } from "@/components/new-thread-button"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { useSideRail } from "@/hooks/use-side-rail"
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
  const railed = useSideRail() > 0

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
      <Stack.Screen
        options={{
          headerShown: true,
          title: copy("mobile_home_title"),
          headerRight: isIOS ? undefined : () => <HomeHeaderButtons />,
        }}
      />
      {isIOS && <HomeToolbar />}
      <HomeContent />
      {!railed && <NewThreadButton onPress={() => setNewThreadOpen(true)} />}
      <NewThreadSheet open={newThreadOpen} onClose={() => setNewThreadOpen(false)} />
    </>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { padding: 4 },
  center: { flex: 1, justifyContent: "center" },
})
