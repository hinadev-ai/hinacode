import { router, Stack, useLocalSearchParams } from "expo-router"
import { useState } from "react"
import { KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Chat } from "@/components/chat"
import { PullRequests } from "@/components/pull-requests"
import { TerminalPanel } from "@/components/terminal"
import { Icon } from "@/components/icon"
import { IconButton, Notice, ProviderLabel, ThreadStatusPill } from "@/components/ui"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { useThreads } from "@/stores/threads"

const tabs = [
  { id: "chat", label: "Chat", icon: "RiChat1Line" },
  { id: "prs", label: "PRs", icon: "RiGitPullRequestLine" },
  { id: "terminal", label: "Terminal", icon: "RiTerminalBoxLine" },
] as const
type Tab = (typeof tabs)[number]["id"]

export default function ThreadScreen() {
  const theme = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const thread = useThreads((state) => state.byId[id])
  const loaded = useThreads((state) => state.status === "ready")
  const status = useConnection((state) => state.status)
  // A desktop without `terminal.attach` ends the shell on every reconnect, so the panel starts a new one.
  const terminalKey = useConnection((state) => (state.features.has("terminal-attach") ? "attached" : state.generation))
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
        <IconButton
          testID="back-button"
          icon="RiArrowLeftSLine"
          accessibilityLabel="Back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
        <View style={styles.titleColumn}>
          <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: theme.text }]}>
            {thread?.title || "Thread"}
          </Text>
          {thread !== undefined && <ProviderLabel provider={thread.provider} size={12} />}
        </View>
        {thread !== undefined && (
          <View style={styles.status}>
            <ThreadStatusPill status={thread.status} />
          </View>
        )}
      </View>
      <View accessibilityRole="tablist" style={[styles.tabs, { backgroundColor: theme.surface }]}>
        {tabs.map((item) => {
          const selected = item.id === tab
          const color = selected ? theme.text : theme.textMuted
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
              <Icon name={item.icon} size={16} color={color} />
              <Text style={{ color, fontWeight: "600" }}>{item.label}</Text>
            </Pressable>
          )
        })}
      </View>
      {status !== "connected" && (
        <View style={styles.banner}>
          <Notice text={copy("mobile_reconnecting_banner")} tone="attention" />
        </View>
      )}
      {thread === undefined ? (
        <View style={styles.missing}>
          <Text style={{ color: theme.textMuted, fontSize: 15 }}>
            {loaded ? "This thread no longer exists." : "Loading thread"}
          </Text>
        </View>
      ) : (
        // Android draws edge to edge, so the window no longer shrinks for the keyboard and needs padding too.
        <KeyboardAvoidingView style={styles.flex} behavior="padding">
          <View style={[styles.flex, tab !== "chat" && styles.hidden]}>
            <Chat thread={thread} />
          </View>
          {tab === "prs" && <PullRequests thread={thread} />}
          {terminalOpened && (
            <View style={[styles.flex, tab !== "terminal" && styles.hidden]}>
              <TerminalPanel key={terminalKey} threadId={thread.id} />
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
    paddingHorizontal: 4,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titleColumn: { flex: 1, gap: 2 },
  title: { fontSize: 16, fontWeight: "600" },
  status: { paddingRight: 8 },
  tabs: { flexDirection: "row", margin: 12, padding: 3, borderRadius: radius.md + 3, gap: 3 },
  tab: {
    flex: 1,
    minHeight: HIT,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
  },
  banner: { paddingHorizontal: 12, paddingBottom: 8 },
  missing: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
})
