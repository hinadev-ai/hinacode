import { router, Stack, useLocalSearchParams } from "expo-router"
import { useState } from "react"
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Chat } from "@/components/chat"
import { PullRequests } from "@/components/pull-requests"
import { TerminalPanel } from "@/components/terminal"
import { Button, Notice, Pill, ThreadStatusPill } from "@/components/ui"
import { HIT } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { useThreads } from "@/stores/threads"

const tabs = [
  { id: "chat", label: "Chat" },
  { id: "prs", label: "PRs" },
  { id: "terminal", label: "Terminal" },
] as const
type Tab = (typeof tabs)[number]["id"]

export default function ThreadScreen() {
  const theme = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const thread = useThreads((state) => state.byId[id])
  const loaded = useThreads((state) => state.status === "ready")
  const status = useConnection((state) => state.status)
  const [tab, setTab] = useState<Tab>("chat")
  // The shell outlives tab switches and ends with this screen.
  const [terminalOpened, setTerminalOpened] = useState(false)

  const select = (next: Tab) => {
    setTab(next)
    if (next === "terminal") setTerminalOpened(true)
  }

  return (
    <SafeAreaView edges={["top", "bottom"]} style={[styles.screen, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { borderColor: theme.border }]}>
        <Button
          testID="back-button"
          label="Back"
          variant="ghost"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {thread?.title || "Thread"}
        </Text>
        {thread !== undefined && (
          <View style={styles.meta}>
            <ThreadStatusPill status={thread.status} />
            <Pill label={thread.provider} tone="neutral" />
          </View>
        )}
      </View>
      <View accessibilityRole="tablist" style={[styles.tabs, { backgroundColor: theme.surface }]}>
        {tabs.map((item) => {
          const selected = item.id === tab
          return (
            <Pressable
              key={item.id}
              testID={`tab-${item.id}`}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected }}
              onPress={() => select(item.id)}
              style={[styles.tab, selected && { backgroundColor: theme.background, borderColor: theme.border }]}
            >
              <Text style={{ color: selected ? theme.text : theme.textMuted, fontWeight: "600" }}>{item.label}</Text>
            </Pressable>
          )
        })}
      </View>
      {status !== "connected" && (
        <View style={styles.banner}>
          <Notice text="Reconnecting to the desktop. Actions are paused." tone="attention" />
        </View>
      )}
      {thread === undefined ? (
        <View style={styles.missing}>
          <Text style={{ color: theme.textMuted, fontSize: 15 }}>
            {loaded ? "This thread no longer exists." : "Loading thread"}
          </Text>
        </View>
      ) : (
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={[styles.flex, tab !== "chat" && styles.hidden]}>
            <Chat thread={thread} />
          </View>
          {tab === "prs" && <PullRequests thread={thread} />}
          {terminalOpened && (
            <View style={[styles.flex, tab !== "terminal" && styles.hidden]}>
              <TerminalPanel threadId={thread.id} />
            </View>
          )}
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  hidden: { display: "none" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontSize: 16, fontWeight: "600" },
  meta: { flexDirection: "row", gap: 6, paddingRight: 8 },
  tabs: { flexDirection: "row", margin: 12, padding: 3, borderRadius: 10, gap: 3 },
  tab: {
    flex: 1,
    minHeight: HIT,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
  },
  banner: { paddingHorizontal: 12, paddingBottom: 8 },
  missing: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
})
