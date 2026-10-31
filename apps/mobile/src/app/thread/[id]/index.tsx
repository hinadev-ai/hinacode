import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router"
import { useHeaderHeight } from "expo-router/react-navigation"
import { useCallback, useState } from "react"
import { AppState, KeyboardAvoidingView, StyleSheet, Text, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Chat } from "@/components/chat"
import { FilesPanel } from "@/components/files"
import { isIOS } from "@/components/glass"
import { ThreadPullRequestChip } from "@/components/pull-request-badge"
import { PullRequests } from "@/components/pull-requests"
import { TerminalPanel } from "@/components/terminal"
import { useThreadActions } from "@/components/thread-actions"
import { SidebarButton, SidebarToolbarButton } from "@/components/thread-sidebar"
import {
  IconButton,
  Notice,
  PILL_HEIGHT,
  ProviderLabel,
  type Segment,
  SegmentedControl,
  ThreadStatusPill,
} from "@/components/ui"
import { useThreadConnection } from "@/hooks/use-server"
import { READABLE_WIDTH } from "@/constants/theme"
import { useSplitLayout } from "@/hooks/use-split-layout"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import type { Thread } from "@shared/domain.ts"
import type { ThreadActionName } from "@/lib/thread-actions"
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
  const split = useSplitLayout()
  const { id } = useLocalSearchParams<{ id: string }>()
  const thread = useThreads((state) => state.byId[id])
  const loaded = useThreads((state) => state.status === "ready")
  const status = useThreadConnection(id)
  // KeyboardAvoidingView measures itself against its parent, which starts below the stack header.
  const headerHeight = useHeaderHeight()
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

  const title = thread?.title || copy("mobile_notify_untitled")

  return (
    <SafeAreaView
      edges={isIOS ? ["bottom"] : ["top", "bottom"]}
      style={[styles.screen, { backgroundColor: theme.background }]}
    >
      {isIOS ? (
        <>
          <Stack.Screen options={{ headerShown: true, title, headerBackVisible: !split }} />
          {split && <SidebarToolbarButton />}
          {thread !== undefined && <ThreadMenu thread={thread} />}
        </>
      ) : (
        <Stack.Screen options={{ headerShown: false }} />
      )}
      {!isIOS && (
        <View style={[styles.header, { borderColor: theme.border }]}>
          {/* In a split the list replaces the back stack, so this corner shows or hides it instead. */}
          {split ? (
            <SidebarButton />
          ) : (
            <IconButton
              testID="back-button"
              icon="RiArrowLeftSLine"
              accessibilityLabel={copy("mobile_thread_back")}
              onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
            />
          )}
          <View style={styles.titleColumn}>
            <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
              {title}
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
      )}
      {/* Lined up with the chat column below it. */}
      <View style={styles.readable}>
        {isIOS && thread !== undefined && (
          <View style={styles.subheader}>
            <ProviderLabel provider={thread.provider} size={12} />
            <View style={styles.spacer} />
            <ThreadPullRequestChip thread={thread} onPress={() => select("prs")} />
            {/* A pill aligns itself to the start, which in this row is the top. The slot keeps the row's height while it hides. */}
            <View style={styles.pillSlot}>
              <ThreadStatusPill status={thread.status} />
            </View>
          </View>
        )}
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
      </View>
      {thread === undefined ? (
        <View style={styles.missing}>
          <Text style={{ color: theme.textMuted, fontSize: 15 }}>
            {loaded ? copy("mobile_thread_missing") : copy("mobile_thread_loading")}
          </Text>
        </View>
      ) : (
        // Android draws edge to edge, so the window no longer shrinks for the keyboard and needs padding too.
        <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
          <View style={[styles.flex, styles.readable, tab !== "chat" && styles.hidden]}>
            <Chat thread={thread} active={tab === "chat"} />
          </View>
          {opened.has("files") && (
            <View style={[styles.flex, styles.readable, tab !== "files" && styles.hidden]}>
              <FilesPanel thread={thread} />
            </View>
          )}
          {tab === "prs" && <PullRequests thread={thread} />}
          {opened.has("terminal") && (
            <View style={[styles.flex, tab !== "terminal" && styles.hidden]}>
              <TerminalPanel threadId={thread.id} />
            </View>
          )}
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  )
}

const actionSymbols = {
  pin: "pin",
  unpin: "pin.slash",
  "copy-id": "doc.on.doc",
  archive: "archivebox",
  unarchive: "tray.and.arrow.up",
} as const satisfies Record<ThreadActionName, string>

/**
 * The thread's actions in the native iOS header menu, with the same behavior as the list's long-press sheet.
 * Archiving the open thread leaves it, as Mail leaves a message it archives.
 */
function ThreadMenu({ thread }: { thread: Thread }) {
  const state = useThreadActions(thread)
  const run = async (name: ThreadActionName) => {
    if (!(await state.run(name))) return
    if (name === "archive") {
      if (router.canGoBack()) router.back()
      else router.replace("/")
    }
  }
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel={copy("mobile_thread_actions")}>
          {state.actions.map((action) => (
            <Stack.Toolbar.MenuAction
              key={action.name}
              icon={actionSymbols[action.name]}
              disabled={state.running !== null}
              onPress={() => void run(action.name)}
            >
              {action.label}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {state.error !== null && (
        <View style={styles.banner}>
          <Notice text={state.error} tone="danger" />
        </View>
      )}
    </>
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
  readable: { width: "100%", maxWidth: READABLE_WIDTH, alignSelf: "center" },
  titleColumn: { flex: 1, gap: 2 },
  title: { fontSize: 16, lineHeight: 20, fontWeight: "600" },
  status: { flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8 },
  subheader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  spacer: { flex: 1 },
  pillSlot: { minHeight: PILL_HEIGHT },
  tabs: { margin: 12 },
  banner: { paddingHorizontal: 12, paddingBottom: 8 },
  missing: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
})
