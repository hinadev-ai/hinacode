import type { PushEvent } from "@shared/contract.ts"
import { useEffect, useRef, useState } from "react"
import { StyleSheet, View } from "react-native"
import { Notice } from "@/components/ui"
import { useTheme } from "@/hooks/use-theme"
import { call, onEvent } from "@/lib/connection"
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

  const onInput = (data: string) => {
    if (session.current !== null && exitCode === undefined) {
      void call("terminal.write", { id: session.current.id, data }).catch(() => {})
    }
  }

  return (
    <View style={styles.container}>
      {error !== null && <Notice text={`Could not open a shell: ${error}`} tone="danger" />}
      {exitCode !== undefined && (
        <Notice text={`Shell exited${exitCode === null ? "" : ` with code ${exitCode}`}.`} />
      )}
      <TerminalView ref={view} theme={theme} onInput={onInput} onSize={onSize} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 8 },
})
