import { useLayoutEffect, useRef } from "react"
import type { Worktree } from "../../shared/domain.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"

/** Distance from the bottom, in pixels, within which new output keeps the log pinned to the end. */
const STICK_THRESHOLD = 24

/** The setup script's combined stdout and stderr, following new output while scrolled to the end. */
export function WorktreeSetupLog({ worktree }: { worktree: Worktree }) {
  const logRef = useRef<HTMLPreElement>(null)
  const pinnedRef = useRef(true)
  const { setupLog } = worktree

  useLayoutEffect(() => {
    const log = logRef.current
    if (log && setupLog && pinnedRef.current) log.scrollTop = log.scrollHeight
  }, [setupLog])

  const onScroll = () => {
    const log = logRef.current
    if (log) pinnedRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < STICK_THRESHOLD
  }

  return (
    <div className="flex flex-col gap-2">
      {worktree.status === "failed" && (
        <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          {m.panel_setup_failed()}
        </p>
      )}
      {setupLog === "" ? (
        <p className="text-xs text-muted-foreground">
          {worktree.status === "preparing" ? m.panel_setup_waiting() : m.panel_setup_none()}
        </p>
      ) : (
        <pre
          ref={logRef}
          onScroll={onScroll}
          role="log"
          aria-label={m.panel_setup_log()}
          className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2.5 font-mono text-xs/relaxed whitespace-pre-wrap wrap-break-word"
        >
          {setupLog}
        </pre>
      )}
      {worktree.status === "preparing" && (
        <Button
          variant="outline"
          size="xs"
          className="self-start"
          onClick={() => void callPromise("worktrees.stopSetup", { id: worktree.id })}
        >
          {m.panel_setup_stop()}
        </Button>
      )}
    </div>
  )
}
