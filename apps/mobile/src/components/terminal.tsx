import type { PushEvent } from "@shared/contract.ts"
import { useEffect, useRef, useState } from "react"
import { Keyboard, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { Icon } from "@/components/icon"
import { Notice } from "@/components/ui"
import { radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, onEvent } from "@/lib/connection"
import { keySequence, type TerminalKey, terminalKeys, withCtrl } from "./terminal-keys"
import type { TerminalViewHandle } from "./terminal-types"
import { TerminalView } from "./terminal-view"

type TerminalPush = Extract<PushEvent, { type: "terminal.data" | "terminal.exited" }>

const clamp = (value: number) => Math.min(1000, Math.max(1, Math.floor(value)))

/**
 * A shell in the thread's worktree. The session opens once the view knows its grid size and is
 * closed when this component unmounts, i.e. when the thread screen goes away.
 */
export function TerminalPanel({ threadId }: { threadId: string }) {
  const theme = useTheme()
  const view = useRef<TerminalViewHandle>(null)
  const session = useRef<{ id: string; size: string } | null>(null)
  const opening = useRef(false)
  // Output can arrive before `terminal.open` answers with the session id.
  const early = useRef<TerminalPush[]>([])
  const latestSize = useRef({ cols: 80, rows: 24 })
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const applicationCursor = useRef(false)
  const [ctrl, setCtrl] = useState(false)
  const keyboardVisible = useKeyboardVisible()

  const apply = (push: TerminalPush) => {
    if (push.type === "terminal.data") view.current?.write(push.data)
    else setExitCode(push.exitCode)
  }

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== "terminal.data" && event.type !== "terminal.exited") return
        if (session.current === null) {
          if (opening.current) early.current.push(event)
        } else if (event.id === session.current.id) apply(event)
      }),
    [],
  )

  useEffect(
    () => () => {
      if (session.current !== null) void call("terminal.close", { id: session.current.id }).catch(() => {})
    },
    [],
  )

  const resize = (current: { id: string; size: string }) => {
    const { cols, rows } = latestSize.current
    const size = `${cols}x${rows}`
    if (current.size === size) return
    current.size = size
    void call("terminal.resize", { id: current.id, cols, rows }).catch(() => {})
  }

  const onSize = (cols: number, rows: number) => {
    latestSize.current = { cols: clamp(cols), rows: clamp(rows) }
    if (session.current !== null) return resize(session.current)
    if (opening.current) return
    opening.current = true
    call("terminal.open", { threadId, ...latestSize.current }).then(
      (opened) => {
        const current = { id: opened.id, size: `${opened.cols}x${opened.rows}` }
        session.current = current
        for (const push of early.current) if (push.id === opened.id) apply(push)
        early.current = []
        resize(current)
      },
      (cause) => {
        opening.current = false
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }

  const send = (data: string) => {
    if (session.current !== null && exitCode === undefined) {
      void call("terminal.write", { id: session.current.id, data }).catch(() => {})
    }
  }

  const onInput = (data: string) => {
    send(ctrl ? withCtrl(data) : data)
    setCtrl(false)
  }

  const onKey = (key: TerminalKey) => {
    send(keySequence(key, applicationCursor.current))
    setCtrl(false)
  }

  return (
    <View style={styles.container}>
      {error !== null && <Notice text={`Could not open a shell: ${error}`} tone="danger" />}
      {exitCode !== undefined && (
        <Notice text={`Shell exited${exitCode === null ? "" : ` with code ${exitCode}`}.`} />
      )}
      <View style={[styles.surface, { borderColor: theme.border }]}>
        <TerminalView
          ref={view}
          theme={theme}
          onInput={onInput}
          onSize={onSize}
          onCursorMode={(mode) => (applicationCursor.current = mode)}
        />
      </View>
      {keyboardVisible && exitCode === undefined && (
        <KeyRow ctrl={ctrl} onCtrl={() => setCtrl((armed) => !armed)} onKey={onKey} />
      )}
    </View>
  )
}

/** The keys a phone keyboard lacks. Ctrl applies to the next character typed on the keyboard. */
function KeyRow({ ctrl, onCtrl, onKey }: { ctrl: boolean; onCtrl: () => void; onKey: (key: TerminalKey) => void }) {
  const theme = useTheme()
  const keyStyle =
    (active: boolean) =>
    ({ pressed }: { pressed: boolean }) => [
      styles.key,
      { backgroundColor: active ? theme.primary : theme.surface, borderColor: active ? theme.primary : theme.border },
      pressed && styles.pressed,
    ]
  return (
    <View accessibilityRole="toolbar" accessibilityLabel="Terminal keys" style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Control"
        accessibilityHint="Applies Control to the next key you type"
        accessibilityState={{ selected: ctrl }}
        onPress={onCtrl}
        style={keyStyle(ctrl)}
      >
        <Text style={[styles.label, { color: ctrl ? theme.onPrimary : theme.text }]}>Ctrl</Text>
      </Pressable>
      {terminalKeys.map(({ key, label, icon }) => (
        <Pressable
          key={key}
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => onKey(key)}
          style={keyStyle(false)}
        >
          {icon ? (
            <Icon name={icon} size={20} color={theme.text} />
          ) : (
            <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
          )}
        </Pressable>
      ))}
    </View>
  )
}

function useKeyboardVisible() {
  const [visible, setVisible] = useState(() => Keyboard.isVisible())
  useEffect(() => {
    // iOS announces the keyboard before it animates in; Android only reports it once it is up.
    const shown = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () =>
      setVisible(true),
    )
    const hidden = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () =>
      setVisible(false),
    )
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])
  return visible
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 8, paddingHorizontal: 12, paddingBottom: 12 },
  row: { flexDirection: "row", gap: 6 },
  key: {
    flex: 1,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.6 },
  label: { fontSize: 14, fontWeight: "600" },
  surface: {
    flex: 1,
    overflow: "hidden",
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
})
