import type { Thread } from "@shared/domain.ts"
import { setStringAsync } from "expo-clipboard"
import { useEffect, useEffectEvent, useState } from "react"
import { AccessibilityInfo, Modal, Pressable, StyleSheet, Text, View } from "react-native"
import Animated, { SlideInDown } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon } from "@/components/icon"
import { IconSwap, Spinner } from "@/components/motion"
import { Notice } from "@/components/ui"
import { duration, ease } from "@/constants/motion"
import { Colors, HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { requestThreadAction, type ThreadActionName, threadActions } from "@/lib/thread-actions"
import { useThreads } from "@/stores/threads"

/** Runs a thread action and keeps its progress and error, for the row's sheet and its accessibility actions. */
export function useThreadActions(thread: Thread) {
  const [running, setRunning] = useState<ThreadActionName | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (name: ThreadActionName) => {
    setRunning(name)
    setError(null)
    try {
      if (name === "copy-id") {
        await setStringAsync(thread.id)
        AccessibilityInfo.announceForAccessibility(copy("mobile_thread_actions_copied"))
      } else {
        useThreads.getState().upsert(await requestThreadAction(thread, name))
      }
      return true
    } catch (cause) {
      setError(errorText(cause))
      return false
    } finally {
      setRunning(null)
    }
  }
  return { actions: threadActions(thread), running, error, run, clearError: () => setError(null) }
}

const rise = SlideInDown.duration(duration.sheet).easing(ease.drawer)
const COPIED_MS = 800

/** A short action list that rises from the bottom over a scrim, with the thread's title on top. */
export function ThreadActionsSheet({
  thread,
  open,
  onClose,
  state,
}: {
  thread: Thread
  open: boolean
  onClose: () => void
  state: ReturnType<typeof useThreadActions>
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const title = thread.title || copy("mobile_home_untitled")
  const close = () => {
    state.clearError()
    onClose()
  }
  const [copied, setCopied] = useState(false)

  const finishCopy = useEffectEvent(() => {
    setCopied(false)
    onClose()
  })
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(finishCopy, COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const run = async (name: ThreadActionName) => {
    if (!(await state.run(name))) return
    if (name === "copy-id") setCopied(true)
    else onClose()
  }
  const busy = state.running !== null || copied
  return (
    <Modal transparent animationType="fade" visible={open} onRequestClose={close}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy("mobile_thread_actions_cancel")}
        onPress={close}
        style={styles.scrim}
      />
      <Animated.View
        entering={rise}
        accessibilityViewIsModal
        style={[
          styles.sheet,
          { paddingBottom: 8 + insets.bottom, backgroundColor: theme.background },
        ]}
      >
        <Text accessibilityRole="header" numberOfLines={2} style={[styles.title, { color: theme.textMuted }]}>
          {title}
        </Text>
        <View style={[styles.group, { backgroundColor: theme.surface }]}>
          {state.actions.map((action, index) => {
            const done = copied && action.name === "copy-id"
            const label = done ? copy("mobile_thread_actions_copied") : action.label
            return (
              <Pressable
                key={action.name}
                testID={`thread-action-${action.name}`}
                accessibilityRole="button"
                accessibilityLabel={label}
                aria-busy={state.running === action.name}
                aria-disabled={busy}
                disabled={busy}
                onPress={() => void run(action.name)}
                style={({ pressed }) => [
                  styles.action,
                  index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
                  pressed && { backgroundColor: theme.surfaceStrong },
                ]}
              >
                {state.running === action.name ? (
                  <Spinner size={18} color={theme.text} />
                ) : (
                  <IconSwap
                    showSecond={done}
                    first={<Icon name={action.icon} size={18} color={theme.text} />}
                    second={<Icon name="RiCheckLine" size={18} color={theme.running} />}
                  />
                )}
                <Text style={[styles.actionLabel, { color: theme.text }]}>{label}</Text>
              </Pressable>
            )
          })}
        </View>
        {state.error !== null && <Notice text={state.error} tone="danger" />}
        <Pressable
          testID="thread-action-cancel"
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_thread_actions_cancel")}
          onPress={close}
          style={({ pressed }) => [
            styles.action,
            styles.cancel,
            { backgroundColor: pressed ? theme.surfaceStrong : theme.surface },
          ]}
        >
          <Text style={[styles.cancelLabel, { color: theme.text }]}>{copy("mobile_thread_actions_cancel")}</Text>
        </Pressable>
      </Animated.View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  // The scrim is dark in both themes, so it borrows the dark palette's background.
  scrim: { flex: 1, backgroundColor: Colors.dark.background, opacity: 0.5 },
  sheet: {
    gap: 8,
    paddingHorizontal: 8,
    paddingTop: 12,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  title: { fontSize: 13, fontWeight: "600", textAlign: "center", paddingHorizontal: 16, paddingBottom: 4 },
  group: { borderRadius: radius.md, overflow: "hidden" },
  action: { minHeight: HIT + 6, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16 },
  actionLabel: { fontSize: 16 },
  cancel: { justifyContent: "center", borderRadius: radius.md },
  cancelLabel: { fontSize: 16, fontWeight: "600" },
})
