import { isThreadBusy, type Thread } from "@shared/domain.ts"
import { useState } from "react"
import { Pressable, StyleSheet, View } from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { AccessModePicker } from "@/components/access-mode"
import { GlassFill, liquidGlass } from "@/components/glass"
import { Icon, type IconName } from "@/components/icon"
import { PressableScale, Spinner } from "@/components/motion"
import { Notice } from "@/components/ui"
import { cssEase, duration } from "@/constants/motion"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"

export type ThreadTab = "chat" | "files" | "prs" | "terminal"

export const threadTabs: readonly { value: ThreadTab; label: string; icon: IconName }[] = [
  { value: "chat", label: copy("mobile_thread_tab_chat"), icon: "Chat" },
  { value: "files", label: copy("mobile_thread_tab_files"), icon: "Folder" },
  { value: "prs", label: copy("mobile_thread_tab_prs"), icon: "RiGitPullRequestLine" },
  { value: "terminal", label: copy("mobile_thread_tab_terminal"), icon: "Terminal" },
]

const BAR_PADDING = 6

/** The thread's views as icon tabs, then Stop while a turn runs, then the access mode. */
export function ThreadControlBar({
  thread,
  tab,
  onSelect,
}: {
  thread: Thread
  tab: ThreadTab
  onSelect: (tab: ThreadTab) => void
}) {
  const theme = useTheme()
  const reduced = useReducedMotion()
  const [error, setError] = useState<string | null>(null)
  const index = Math.max(
    0,
    threadTabs.findIndex((item) => item.value === tab),
  )
  return (
    <View style={styles.wrap}>
      <View
        style={[
          styles.bar,
          liquidGlass ? styles.glass : [styles.solid, { backgroundColor: theme.card, borderColor: theme.border }],
        ]}
      >
        <GlassFill />
        <View accessibilityRole="tablist" accessibilityLabel={copy("mobile_thread_tabs")} style={styles.tabs}>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.thumb,
              {
                backgroundColor: theme.card,
                borderColor: theme.border,
                transform: [{ translateX: index * HIT }],
                transitionProperty: "transform",
                transitionDuration: reduced ? 0 : duration.base,
                transitionTimingFunction: cssEase.out,
              },
            ]}
          />
          {threadTabs.map((item) => {
            const selected = item.value === tab
            return (
              <Pressable
                key={item.value}
                testID={`tab-${item.value}`}
                accessibilityRole="tab"
                accessibilityLabel={item.label}
                aria-selected={selected}
                onPress={() => onSelect(item.value)}
                style={styles.tab}
              >
                <Icon name={item.icon} size={20} color={selected ? theme.text : theme.textMuted} />
              </Pressable>
            )
          })}
        </View>
        <View style={[styles.divider, { backgroundColor: theme.border }]} />
        <View style={styles.spacer} />
        {isThreadBusy(thread.status) && <StopButton thread={thread} onError={setError} />}
        <AccessModePicker thread={thread} />
      </View>
      {error !== null && <Notice text={error} tone="danger" />}
    </View>
  )
}

function StopButton({ thread, onError }: { thread: Thread; onError: (message: string | null) => void }) {
  const theme = useTheme()
  const [stopping, setStopping] = useState(false)
  const stop = async () => {
    setStopping(true)
    onError(null)
    try {
      await call("threads.interrupt", { threadId: thread.id })
    } catch (cause) {
      onError(errorText(cause))
    }
    setStopping(false)
  }
  return (
    <PressableScale
      testID="thread-stop"
      accessibilityRole="button"
      accessibilityLabel={copy("mobile_composer_stop")}
      aria-busy={stopping}
      disabled={stopping}
      onPress={() => void stop()}
      style={[styles.stop, { backgroundColor: theme.surface }]}
    >
      {stopping ? (
        <Spinner size={16} color={theme.danger} />
      ) : (
        <Icon name="Stop" size={16} color={theme.danger} />
      )}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, gap: 8 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: BAR_PADDING,
    borderRadius: radius.full,
  },
  glass: { overflow: "hidden" },
  solid: { borderWidth: StyleSheet.hairlineWidth, boxShadow: "0 4px 16px rgba(0, 0, 0, 0.06)" },
  tabs: { flexDirection: "row" },
  tab: { width: HIT, height: HIT, alignItems: "center", justifyContent: "center" },
  thumb: {
    position: "absolute",
    width: HIT,
    height: HIT,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    boxShadow: "0 2px 6px rgba(0, 0, 0, 0.12)",
  },
  divider: { width: StyleSheet.hairlineWidth * 2, height: 24, marginHorizontal: 4 },
  spacer: { flex: 1 },
  stop: { width: HIT, height: HIT, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
})
