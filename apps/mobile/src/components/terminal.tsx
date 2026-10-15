import type { PushEvent } from "@shared/contract.ts"
import { useEffect, useRef, useState } from "react"
import { Keyboard, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { Icon } from "@/components/icon"
import { Notice } from "@/components/ui"
import { radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, onEvent, useConnection } from "@/lib/connection"
import { errorText } from "@/lib/error-text"
import { keySequence, type TerminalKey, terminalKeys, withCtrl } from "./terminal-keys"
import type { TerminalViewHandle } from "./terminal-types"
import { TerminalView } from "./terminal-view"

type TerminalPush = Extract<PushEvent, { type: "terminal.data" | "terminal.exited" }>
type Session = { readonly id: string; size: string; generation: number }

const clamp = (value: number) => Math.min(1000, Math.max(1, Math.floor(value)))

/** Clears the screen and scrollback before output that does not continue what is shown. */
const RESET = "\x1bc"

/**
 * A shell in the thread's worktree. The session opens once the view knows its grid size and is
 * closed when this component unmounts, i.e. when the thread screen goes away. After a reconnect it
 * attaches to the same session and catches up from the last output it showed.
 */
export function TerminalPanel({ threadId }: { threadId: string }) {
  const theme = useTheme()
  const generation = useConnection((state) => state.generation)
  const view = useRef<TerminalViewHandle>(null)
  const session = useRef<Session | null>(null)
  const opening = useRef(false)
  // `terminal.open` can answer after the screen is gone; that shell has to be closed, not kept.
  const mounted = useRef(false)
  // Output can arrive before `terminal.open` answers with the session id.
  const early = useRef<TerminalPush[]>([])
  // Output that arrives while `terminal.attach` is in flight, applied after what attach returns.
  const attaching = useRef<TerminalPush[] | null>(null)
  /** The output offset just past the last character written, or null before any output with an offset. */
  const written = useRef<number | null>(null)
  const latestSize = useRef({ cols: 80, rows: 24 })
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const applicationCursor = useRef(false)
  const [ctrl, setCtrl] = useState(false)
  const keyboardVisible = useKeyboardVisible()

  const apply = (push: TerminalPush) => {
    if (push.type === "terminal.exited") return setExitCode(push.exitCode)
    const { data, offset } = push
    if (offset === undefined) return view.current?.write(data)
    const end = offset + data.length
    if (written.current !== null && end <= written.current) return
    // Trim what attach already wrote. A gap means output was lost; the next attach repaints it.
    const skip = written.current === null ? 0 : Math.max(0, written.current - offset)
    view.current?.write(data.slice(skip))
    written.current = end
  }

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== "terminal.data" && event.type !== "terminal.exited") return
        if (session.current === null) {
          if (opening.current) early.current.push(event)
        } else if (event.id === session.current.id) {
          if (attaching.current !== null) attaching.current.push(event)
          else apply(event)
        }
      }),
    [],
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // While offline the close waits in the outbox, so the shell does not outlive the screen.
      if (session.current !== null) void call("terminal.close", { id: session.current.id }).catch(() => {})
    }
  }, [])

  useEffect(() => {
    const current = session.current
    if (current === null || current.generation === generation) return
    current.generation = generation
    const since = written.current
    const buffered: TerminalPush[] = []
    attaching.current = buffered
    const finish = () => {
      if (attaching.current !== buffered) return false
      attaching.current = null
      return true
    }
    call("terminal.attach", { id: current.id, since }).then(
      ({ session: attached, offset, data }) => {
        if (!finish()) return
        if (since === null || offset > since) view.current?.write(RESET + data)
        else view.current?.write(data.slice(since - offset))
        written.current = offset + data.length
        if (attached.status === "exited") setExitCode(attached.exitCode)
        for (const push of buffered) apply(push)
      },
      (cause) => {
        if (!finish()) return
        setError(`Could not reconnect to the shell: ${errorText(cause)}`)
        for (const push of buffered) apply(push)
      },
    )
  }, [generation])

  const resize = (current: Session) => {
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
        if (!mounted.current) return void call("terminal.close", { id: opened.id }).catch(() => {})
        const current = {
          id: opened.id,
          size: `${opened.cols}x${opened.rows}`,
          generation: useConnection.getState().generation,
        }
        session.current = current
        for (const push of early.current) if (push.id === opened.id) apply(push)
        early.current = []
        resize(current)
      },
      (cause) => {
        opening.current = false
        setError(`Could not open a shell: ${errorText(cause)}`)
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
      {error !== null && <Notice text={error} tone="danger" />}
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
