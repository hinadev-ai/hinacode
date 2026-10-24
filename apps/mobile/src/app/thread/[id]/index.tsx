import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router"
import { useCallback, useState } from "react"
import { AppState, KeyboardAvoidingView, StyleSheet, Text, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Chat } from "@/components/chat"
import { FilesPanel } from "@/components/files"
import { ThreadPullRequestChip } from "@/components/pull-request-badge"
import { PullRequests } from "@/components/pull-requests"
import { TerminalPanel } from "@/components/terminal"
import { IconButton, Notice, ProviderLabel, type Segment, SegmentedControl, ThreadStatusPill } from "@/components/ui"
import { useThreadConnection } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { useThreads } from "@/stores/threads"
import { useUnseen } from "@/stores/unseen"

type Tab = "chat" | "files" | "prs" | "terminal"

const tabs: readonly Segment<Tab>[] = [
  { value: "chat", label: copy("mobile_thread_tab_chat") },
  { value: "files", label: copy("mobile_thread_tab_files") },
  { value: "prs", label: copy("mobile_thread_tab_prs") },
  { value: "terminal", label: copy("mobile_thread_tab_terminal") },
]

export default function ThreadScreen() {
  const theme = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const thread = useThreads((state) => state.byId[id])
  const loaded = useThreads((state) => state.status === "ready")
  const status = useThreadConnection(id)
  const terminalRemountKey = useConnection((state) => (state.features.has("terminal-attach") ? "attached" : state.generation))
  const [tab, setTab] = useState<Tab>("chat")
  // Files and the shell keep their state across tab switches once opened, and end with this screen.
  const [opened, setOpened] = useState<ReadonlySet<Tab>>(() => new Set(["chat"]))

  // Seeing the thread clears its unopened result, also when the app comes back to it from the background.
  useFocusEffect(
    useCallback(() => {
      useUnseen.getState().clear(id)
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") useUnseen.getState().clear(id)
      })
      return () => subscription.remove()
    }, [id]),
  )

  const select = (next: Tab) => {
    setTab(next)
    if (!opened.has(next)) setOpened(new Set([...opened, next]))
  }

  return (
    <SafeAreaView edges={["top", "bottom"]} style={[styles.screen, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { borderColor: theme.border }]}>
        <IconButton
          testID="back-button"
          icon="RiArrowLeftSLine"
          accessibilityLabel={copy("mobile_thread_back")}
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
        <View style={styles.titleColumn}>
          <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: theme.text }]}>
            {thread?.title || copy("mobile_notify_untitled")}
          </Text>
          {thread !== undefined && <ProviderLabel provider={thread.provider} size={12} />}
        </View>
        {thread !== undefined && (
          <View style={styles.status}>
            <ThreadPullRequestChip thread={thread} onPress={() => select("prs")} />
            <ThreadStatusPill status={thread.status} />
          </View>
        )}
      </View>
      <SegmentedControl
        accessibilityLabel={copy("mobile_thread_tabs")}
        segments={tabs}
        value={tab}
        onChange={select}
        style={styles.tabs}
      />
      {status !== "connected" && (
        <View style={styles.banner}>
          <Notice text={copy("mobile_reconnecting_banner")} tone="attention" />
        </View>
      )}
      {thread === undefined ? (
        <View style={styles.missing}>
          <Text style={{ color: theme.textMuted, fontSize: 15 }}>
            {loaded ? copy("mobile_thread_missing") : copy("mobile_thread_loading")}
          </Text>
        </View>
      ) : (
        // Android draws edge to edge, so the window no longer shrinks for the keyboard and needs padding too.
        <KeyboardAvoidingView style={styles.flex} behavior="padding">
          <View style={[styles.flex, tab !== "chat" && styles.hidden]}>
            <Chat thread={thread} />
          </View>
          {opened.has("files") && (
            <View style={[styles.flex, tab !== "files" && styles.hidden]}>
              <FilesPanel thread={thread} />
            </View>
          )}
          {tab === "prs" && <PullRequests thread={thread} />}
          {opened.has("terminal") && (
            <View style={[styles.flex, tab !== "terminal" && styles.hidden]}>
              <TerminalPanel key={terminalRemountKey} threadId={thread.id} />
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
  status: { flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8 },
  tabs: { margin: 12 },
  banner: { paddingHorizontal: 12, paddingBottom: 8 },
  missing: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
})
