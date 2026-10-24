import { Stack } from "expo-router"
import { useState } from "react"
import { StyleSheet, View } from "react-native"
import { HomeActions, HomeContent } from "@/components/home"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { ConnectionBadge, EmptyState } from "@/components/ui"
import { useSplitLayout } from "@/hooks/use-split-layout"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"

export default function HomeScreen() {
  const theme = useTheme()
  const split = useSplitLayout()
  const connection = useConnection((state) => state.status)
  const [newThreadOpen, setNewThreadOpen] = useState(false)

  // In a wide window the list is the sidebar, so this route is the detail side with nothing open yet.
  if (split)
    return (
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <EmptyState icon="RiChat1Line" title={copy("mobile_home_no_selection")} />
      </View>
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
  screen: { flex: 1, justifyContent: "center" },
  headerLeft: { paddingHorizontal: 4 },
})
