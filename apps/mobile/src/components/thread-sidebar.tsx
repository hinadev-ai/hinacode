import { useGlobalSearchParams } from "expo-router"
import { useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { HomeActions, HomeContent } from "@/components/home"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { ConnectionBadge } from "@/components/ui"
import { SIDEBAR_WIDTH } from "@/hooks/use-split-layout"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"

/** The home list beside the open thread in a wide window, with the header the phone's home screen has. */
export function ThreadSidebar() {
  const theme = useTheme()
  const connection = useConnection((state) => state.status)
  // Thread, file and pull request routes all carry the thread's id.
  const { id } = useGlobalSearchParams<{ id?: string }>()
  const [newThreadOpen, setNewThreadOpen] = useState(false)

  return (
    <SafeAreaView
      edges={["top", "left"]}
      style={[styles.sidebar, { backgroundColor: theme.background, borderColor: theme.border }]}
    >
      <View style={styles.header}>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {copy("mobile_home_title")}
        </Text>
        {connection !== "connected" && <ConnectionBadge status={connection} />}
        <View style={styles.spacer} />
        <HomeActions onNewThread={() => setNewThreadOpen(true)} />
      </View>
      <HomeContent selectedId={id} />
      <NewThreadSheet open={newThreadOpen} onClose={() => setNewThreadOpen(false)} />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  sidebar: { width: SIDEBAR_WIDTH, borderRightWidth: StyleSheet.hairlineWidth },
  header: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 52, paddingLeft: 16, paddingRight: 4 },
  title: { flexShrink: 1, fontSize: 17, fontWeight: "600" },
  spacer: { flex: 1 },
})
