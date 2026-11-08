import type { Thread } from "@shared/domain.ts"
import { setStringAsync } from "expo-clipboard"
import { Link } from "expo-router"
import { useEffect, useEffectEvent, useState } from "react"
import { AccessibilityInfo, Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { Icon } from "@/components/icon"
import { IconSwap, Spinner } from "@/components/motion"
import { GroupedCard } from "@/components/grouped-card"
import { Sheet, sheetStyles } from "@/components/sheet"
import { Button, Notice } from "@/components/ui"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { openThread } from "@/lib/navigation"
import {
  actionGroups,
  isServerAction,
  requestThreadAction,
  type ThreadActionName,
  threadActions,
} from "@/lib/thread-actions"
import { useThreads } from "@/stores/threads"

/** iOS and the web ask for the new title in a system prompt. Android has none, so its sheet shows a field instead. */
const promptTitle = (current: string) =>
  new Promise<string | null>((resolve) => {
    if (Platform.OS === "web") return resolve(window.prompt(copy("mobile_thread_rename_title"), current))
    Alert.prompt(
      copy("mobile_thread_rename_title"),
      undefined,
      [
        { text: copy("mobile_thread_actions_cancel"), style: "cancel", onPress: () => resolve(null) },
        { text: copy("mobile_thread_rename_save"), onPress: (value) => resolve(value ?? null) },
      ],
      "plain-text",
      current,
    )
  })

const confirmDelete = (thread: Thread) =>
  new Promise<boolean>((resolve) => {
    const title = copy("mobile_thread_delete_title", { title: thread.title || copy("mobile_home_untitled") })
    const body = copy("mobile_thread_delete_body")
    if (Platform.OS === "web") return resolve(window.confirm(`${title}\n\n${body}`))
    Alert.alert(
      title,
      body,
      [
        { text: copy("mobile_thread_actions_cancel"), style: "cancel", onPress: () => resolve(false) },
        { text: copy("mobile_thread_actions_delete"), style: "destructive", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    )
  })

/**
 * Runs a thread action and keeps its progress and error, for the row's menu or sheet, its accessibility actions and
 * the thread screen's menu. `run` resolves to whether the action finished. Renaming on Android resolves false and
 * sets `renaming`, so the sheet stays open with a title field.
 */
export function useThreadActions(thread: Thread) {
  const [running, setRunning] = useState<ThreadActionName | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)

  const attempt = async (name: ThreadActionName, action: () => Promise<void>) => {
    setRunning(name)
    setError(null)
    try {
      await action()
      return true
    } catch (cause) {
      setError(errorText(cause))
      return false
    } finally {
      setRunning(null)
    }
  }

  const rename = (title: string) =>
    attempt("rename", async () => {
      const trimmed = title.trim()
      if (trimmed !== "" && trimmed !== thread.title) {
        useThreads.getState().upsert(await call("threads.update", { id: thread.id, title: trimmed }))
      }
      setRenaming(false)
    })

  const run = async (name: ThreadActionName): Promise<boolean> => {
    if (isServerAction(name)) {
      return attempt(name, async () => useThreads.getState().upsert(await requestThreadAction(thread, name)))
    }
    switch (name) {
      case "copy-id":
        return attempt(name, async () => {
          await setStringAsync(thread.id)
          AccessibilityInfo.announceForAccessibility(copy("mobile_thread_actions_copied"))
        })
      case "rename": {
        if (Platform.OS === "android") {
          setError(null)
          setRenaming(true)
          return false
        }
        const title = await promptTitle(thread.title)
        return title === null ? false : rename(title)
      }
      case "fork":
        return attempt(name, async () => {
          const forked = await call("threads.fork", { threadId: thread.id })
          useThreads.getState().upsert(forked)
          openThread(forked.id)
        })
      case "reveal":
        return attempt(name, () => call("threads.reveal", { threadId: thread.id }))
      case "delete":
        if (!(await confirmDelete(thread))) return false
        // The worktree may hold work nobody committed, and the phone cannot show what it would throw away.
        return attempt(name, async () => {
          await call("threads.delete", { id: thread.id, removeWorktree: false })
          useThreads.getState().remove(thread.id)
        })
    }
  }

  return {
    actions: threadActions(thread),
    running,
    error,
    renaming,
    run,
    rename,
    clearError: () => {
      setError(null)
      setRenaming(false)
    },
  }
}

/** Each action's SF Symbol in the native iOS menus. */
export const threadActionSymbols = {
  pin: "pin",
  unpin: "pin.slash",
  rename: "pencil",
  fork: "arrow.triangle.branch",
  "copy-id": "doc.on.doc",
  reveal: "desktopcomputer",
  archive: "archivebox",
  unarchive: "tray.and.arrow.up",
  delete: "trash",
} as const satisfies Record<ThreadActionName, string>

/**
 * The iOS context menu a thread row lifts into on long press: Open, then the actions in their groups. Built by a
 * call rather than as a component, because `Link` finds its menu by the element's type.
 */
export const threadContextMenu = (thread: Thread, state: ReturnType<typeof useThreadActions>) => (
  <Link.Menu>
    <Link.MenuAction icon="arrow.up.right" onPress={() => openThread(thread.id)}>
      {copy("mobile_thread_actions_open")}
    </Link.MenuAction>
    {actionGroups(state.actions).map((group) => (
      <Link.Menu key={group[0]!.name} inline>
        {group.map((action) => (
          <Link.MenuAction
            key={action.name}
            icon={threadActionSymbols[action.name]}
            destructive={action.destructive}
            disabled={state.running !== null}
            onPress={() => void state.run(action.name)}
          >
            {action.label}
          </Link.MenuAction>
        ))}
      </Link.Menu>
    ))}
  </Link.Menu>
)

const COPIED_MS = 800

/** The thread's actions in grouped cards over a scrim, with the thread's title on top. */
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
    <Sheet title={title} open={open} onClose={close} fit>
      {state.renaming ? (
        <RenameForm thread={thread} busy={state.running === "rename"} onSave={(next) => void state.rename(next).then((done) => done && onClose())} />
      ) : (
        actionGroups(state.actions).map((group) => (
          <GroupedCard key={group[0]!.name} inset={16}>
            {group.map((action) => {
              const done = copied && action.name === "copy-id"
              const label = done ? copy("mobile_thread_actions_copied") : action.label
              const color = action.destructive === true ? theme.danger : theme.text
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
                  style={({ pressed }) => [sheetStyles.option, pressed && { backgroundColor: theme.sheetRaised }]}
                >
                  <Text style={[styles.actionLabel, { color }]}>{label}</Text>
                  {state.running === action.name ? (
                    <Spinner size={18} color={color} />
                  ) : (
                    <IconSwap
                      showSecond={done}
                      first={<Icon name={action.icon} size={20} color={color} />}
                      second={<Icon name="Check" size={20} color={theme.running} />}
                    />
                  )}
                </Pressable>
              )
            })}
          </GroupedCard>
        ))
      )}
      {state.error !== null && <Notice text={state.error} tone="danger" />}
    </Sheet>
  )
}

function RenameForm({ thread, busy, onSave }: { thread: Thread; busy: boolean; onSave: (title: string) => void }) {
  const theme = useTheme()
  const [title, setTitle] = useState(thread.title)
  return (
    <View style={styles.rename}>
      <TextInput
        testID="thread-rename-input"
        accessibilityLabel={copy("mobile_thread_rename_title")}
        value={title}
        onChangeText={setTitle}
        onSubmitEditing={() => onSave(title)}
        autoFocus
        selectTextOnFocus
        returnKeyType="done"
        style={[styles.renameInput, { color: theme.text, backgroundColor: theme.card, borderColor: theme.border }]}
      />
      <Button
        testID="thread-rename-save"
        label={copy("mobile_thread_rename_save")}
        variant="primary"
        busy={busy}
        disabled={title.trim() === ""}
        onPress={() => onSave(title)}
        style={styles.renameSave}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  actionLabel: { flex: 1, fontSize: 16 },
  rename: { gap: 12 },
  renameInput: {
    minHeight: HIT + 8,
    paddingHorizontal: 16,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  renameSave: { borderRadius: radius.full },
})
