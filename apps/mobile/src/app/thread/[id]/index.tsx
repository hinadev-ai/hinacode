import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router"
import { useHeaderHeight } from "expo-router/react-navigation"
import { type ReactNode, useEffect, useState } from "react"
import { AppState, KeyboardAvoidingView, StyleSheet, Text, useWindowDimensions, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { ArtifactList } from "@/components/artifact-list"
import { Chat } from "@/components/chat"
import { FilesPanel } from "@/components/files"
import { isIOS } from "@/components/glass"
import { PullRequests } from "@/components/pull-requests"
import { TerminalPanel } from "@/components/terminal"
import { ThreadActionsSheet, useThreadActions } from "@/components/thread-actions"
import { ThreadControlBar } from "@/components/thread-control-bar"
import { threadActionSymbols } from "@/lib/thread-actions"
import { type ThreadTab, threadTabs } from "@/lib/thread-tabs"
import { SidebarButton, SidebarToolbarButton } from "@/components/thread-sidebar"
import { IconButton, Notice } from "@/components/ui"
import { useThreadConnection } from "@/hooks/use-server"
import { type Palette, radius, READABLE_WIDTH } from "@/constants/theme"
import { threadStatusLabel } from "@/constants/thread-status"
import { headerStatus } from "@/lib/header-status"
import { useNow } from "@/hooks/use-now"
import { useSplitLayout } from "@/hooks/use-split-layout"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { relativeTime } from "@/lib/relative-time"
import type { Thread, ThreadStatus } from "@shared/domain.ts"
import { useMessages } from "@/stores/messages"
import { useThreads } from "@/stores/threads"
import { useUnseen } from "@/stores/unseen"
import { useThreadVm, useVms } from "@/stores/vms"

const HEADER_ITEMS_WIDTH = 72

export default function ThreadScreen() {
  const theme = useTheme()
  const split = useSplitLayout()
  const { id } = useLocalSearchParams<{ id: string }>()
  const thread = useThreads((state) => state.byId[id])
  const waiting = useMessages((state) => {
    const history = state.byThread[id]
    return history?.status === "ready" && (history.approvals.length > 0 || history.questions.length > 0)
  })
  const loaded = useThreads((state) => state.status === "ready")
  const status = useThreadConnection(id)
  // FIXME: KeyboardAvoidingView measures itself against its parent, which starts below the stack header.
  const headerHeight = useHeaderHeight()
  const [tab, setTab] = useState<ThreadTab>("chat")
  const [opened, setOpened] = useState<ReadonlySet<ThreadTab>>(() => new Set(["chat"]))

  useFocusEffect(() => {
    useUnseen.getState().clear(id)
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") useUnseen.getState().clear(id)
    })
    return () => subscription.remove()
  })

  useEffect(() => {
    if (status === "connected") void useVms.getState().load(id).catch(() => {})
  }, [status, id])

  const select = (next: ThreadTab) => {
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
          <Stack.Screen
            options={{
              headerShown: true,
              title,
              headerBackVisible: !split,
              headerTitle: () => <ThreadTitle title={title} thread={thread} tab={tab} waiting={waiting} />,
            }}
          />
          {split && <SidebarToolbarButton />}
          {thread !== undefined && <ThreadMenu thread={thread} onOpenTerminal={() => select("terminal")} />}
        </>
      ) : (
        <Stack.Screen options={{ headerShown: false }} />
      )}
      {!isIOS && (
        <View style={styles.header}>
          {split ? (
            <SidebarButton />
          ) : (
            <IconButton
              testID="back-button"
              icon="ArrowLeft"
              accessibilityLabel={copy("mobile_thread_back")}
              onPress={leave}
              style={roundButton(theme)}
            />
          )}
          <ThreadTitle title={title} thread={thread} tab={tab} waiting={waiting} />
          {thread === undefined ? (
            <View style={styles.headerSlot} />
          ) : (
            <>
              <VmButton threadId={thread.id} />
              <ThreadActionsButton thread={thread} onOpenTerminal={() => select("terminal")} />
            </>
          )}
        </View>
      )}
      {status !== "connected" && (
        <View style={[styles.readable, styles.banner]}>
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
        // FIXME: Android draws edge to edge, so the window no longer shrinks for the keyboard and needs padding too.
        <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
          <View style={styles.flex}>
            <TabPanel shown={tab === "chat"} readable>
              <Chat thread={thread} active={tab === "chat"} />
            </TabPanel>
            {opened.has("files") && (
              <TabPanel shown={tab === "files"} readable>
                <FilesPanel thread={thread} />
              </TabPanel>
            )}
            {tab === "prs" && <PullRequests thread={thread} />}
            {tab === "artifacts" && (
              <TabPanel shown readable>
                <ArtifactList threadId={thread.id} />
              </TabPanel>
            )}
            {opened.has("terminal") && (
              <TabPanel shown={tab === "terminal"}>
                <TerminalPanel threadId={thread.id} />
              </TabPanel>
            )}
          </View>
        </KeyboardAvoidingView>
      )}
      {thread !== undefined && <ThreadControlBar tab={tab} onSelect={select} />}
    </SafeAreaView>
  )
}

// FIXME: `display: none` collapses a hidden tab's list to no height and loses its scroll position, so hidden tabs stay laid out.
function TabPanel({ shown, readable = false, children }: { shown: boolean; readable?: boolean; children: ReactNode }) {
  return (
    <View
      pointerEvents={shown ? "auto" : "none"}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      style={[StyleSheet.absoluteFill, !shown && styles.offstage]}
    >
      <View style={[styles.flex, readable && styles.readable]}>{children}</View>
    </View>
  )
}

function ThreadMenu({ thread, onOpenTerminal }: { thread: Thread; onOpenTerminal: () => void }) {
  const state = useThreadActions(thread)
  const hasVm = useHasVm(thread.id)
  return (
    <>
      <Stack.Toolbar placement="right">
        {hasVm && (
          <Stack.Toolbar.Button
            icon="desktopcomputer"
            accessibilityLabel={copy("mobile_vm_open")}
            onPress={() => openVm(thread.id)}
          />
        )}
        <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel={copy("mobile_thread_actions")}>
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction icon="apple.terminal" onPress={onOpenTerminal}>
              {copy("mobile_thread_tab_terminal")}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          {state.actions.map((action) => (
            <Stack.Toolbar.MenuAction
              key={action.name}
              icon={threadActionSymbols[action.name]}
              destructive={action.destructive}
              disabled={state.running !== null}
              onPress={() => void state.run(action.name)}
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

const leave = () => (router.canGoBack() ? router.back() : router.replace("/"))

const openVm = (id: string) => router.push({ pathname: "/thread/[id]/vm", params: { id } })

const useHasVm = (threadId: string) => {
  const vm = useThreadVm(threadId)
  return vm !== undefined && vm.status !== "none"
}

function VmButton({ threadId }: { threadId: string }) {
  const theme = useTheme()
  if (!useHasVm(threadId)) return null
  return (
    <IconButton
      testID="vm-button"
      icon="Computer"
      accessibilityLabel={copy("mobile_vm_open")}
      onPress={() => openVm(threadId)}
      style={roundButton(theme)}
    />
  )
}

function ThreadActionsButton({ thread, onOpenTerminal }: { thread: Thread; onOpenTerminal: () => void }) {
  const theme = useTheme()
  const state = useThreadActions(thread)
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton
        testID="thread-actions-button"
        icon="More"
        accessibilityLabel={copy("mobile_thread_actions")}
        onPress={() => setOpen(true)}
        style={roundButton(theme)}
      />
      <ThreadActionsSheet
        thread={thread}
        open={open}
        onClose={() => setOpen(false)}
        state={state}
        onOpenTerminal={onOpenTerminal}
      />
    </>
  )
}

const statusColor = (theme: Palette, status: ThreadStatus) =>
  status === "awaiting_approval" || status === "limited"
    ? theme.attention
    : status === "running"
      ? theme.running
      : theme.textMuted

function ThreadTitle({
  title,
  thread,
  tab,
  waiting,
}: {
  title: string
  thread: Thread | undefined
  tab: ThreadTab
  waiting: boolean
}) {
  const theme = useTheme()
  const now = useNow()
  const { width } = useWindowDimensions()
  const status = thread === undefined ? undefined : headerStatus(thread.status, waiting)
  const color = status === undefined ? theme.textMuted : statusColor(theme, status)
  const tabLabel = threadTabs.find((item) => item.value === tab)?.label ?? ""
  return (
    <View style={[styles.titleBlock, isIOS ? { maxWidth: width - HEADER_ITEMS_WIDTH * 2 } : styles.flex]}>
      <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: theme.text }]}>
        {title}
      </Text>
      {thread !== undefined && status !== undefined && (
        <View style={styles.subtitle}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text numberOfLines={1} style={[styles.subtitleText, { color }]}>
            {copy("mobile_thread_subtitle", {
              tab: tabLabel,
              status: threadStatusLabel[status],
              age: relativeTime(thread.updatedAt, now),
            })}
          </Text>
        </View>
      )}
    </View>
  )
}

const BUTTON_SHADOW = "0 2px 8px rgba(0, 0, 0, 0.08)"

const roundButton = (theme: Palette) => ({
  borderRadius: radius.full,
  backgroundColor: theme.background,
  borderColor: theme.border,
  boxShadow: BUTTON_SHADOW,
})

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  offstage: { opacity: 0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  headerSlot: { width: 44 },
  readable: { width: "100%", maxWidth: READABLE_WIDTH, alignSelf: "center" },
  titleBlock: { alignItems: "center", gap: 2 },
  title: { fontSize: 17, lineHeight: 22, fontWeight: "600", textAlign: "center" },
  subtitle: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" },
  dot: { width: 7, height: 7, borderRadius: radius.full },
  subtitleText: { flexShrink: 1, fontSize: 13, lineHeight: 17 },
  banner: { paddingHorizontal: 12, paddingBottom: 8 },
  missing: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
})
