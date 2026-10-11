import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useId, useState, useTransition } from "react"
import { RiCloseCircleLine } from "react-icons/ri"
import type { OpenPort } from "../../shared/domain.ts"
import { callPromise, threadPortsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

/** Listening TCP ports opened from the thread's workspace or by its agent, refreshed every 2s. */
export function ThreadPorts({ threadId }: { threadId: string }) {
  const ports = useAtomValue(threadPortsAtom(threadId))
  const refresh = useAtomRefresh(threadPortsAtom(threadId))
  const [killError, setKillError] = useState<string | null>(null)
  const headingId = useId()

  const failed = (message: string) => (
    <div role="alert" className="flex items-center gap-2">
      <p className="text-sm text-destructive">{m.ports_failed({ message })}</p>
      <Button variant="outline" size="xs" onClick={refresh}>
        {m.sidebar_retry()}
      </Button>
    </div>
  )

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
      <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
        {m.ports_title()}
      </h3>
      {AsyncResult.builder(ports)
        .onInitial(() => <p className="text-sm text-muted-foreground">{m.ports_loading()}</p>)
        .onSuccess((list) =>
          list.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.ports_empty()}</p>
          ) : (
            <ul className="flex flex-col">
              {list.map((port) => (
                <PortRow
                  key={`${port.port}:${port.pid}`}
                  port={port}
                  onKilled={() => {
                    setKillError(null)
                    refresh()
                  }}
                  onKillFailed={setKillError}
                />
              ))}
            </ul>
          ),
        )
        .onError((error) => failed(error.message))
        .orElse(() => failed(""))}
      {killError && (
        <p role="alert" className="text-xs text-destructive">
          {m.ports_kill_failed({ message: killError })}
        </p>
      )}
    </section>
  )
}

interface PortRowProps {
  readonly port: OpenPort
  readonly onKilled: () => void
  readonly onKillFailed: (message: string) => void
}

function PortRow({ port, onKilled, onKillFailed }: PortRowProps) {
  // Killing takes two clicks: the first arms the button and the tooltip asks for confirmation.
  const [armed, setArmed] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [pending, startTransition] = useTransition()

  const onClick = () => {
    if (!armed) return setArmed(true)
    setArmed(false)
    startTransition(async () => {
      try {
        await callPromise("ports.kill", { pid: port.pid })
        onKilled()
      } catch (cause) {
        onKillFailed(cause instanceof Error ? cause.message : String(cause))
      }
    })
  }

  return (
    <li className="flex items-center gap-2 py-0.5 text-sm">
      <span className="w-14 shrink-0 font-mono tabular-nums">:{port.port}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={port.cwd ?? undefined}>
        {m.ports_process({ command: port.command, pid: String(port.pid) })}
      </span>
      <Tooltip open={armed || hovered} onOpenChange={setHovered}>
        <TooltipTrigger
          render={
            <Button
              variant={armed ? "destructive" : "ghost"}
              size="icon-xs"
              aria-label={m.ports_kill({ command: port.command, port: String(port.port) })}
              disabled={pending}
              onClick={onClick}
              onBlur={() => setArmed(false)}
            />
          }
        >
          <RiCloseCircleLine aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="top">
          {armed
            ? m.ports_kill_confirm({ command: port.command })
            : m.ports_kill({ command: port.command, port: String(port.port) })}
        </TooltipContent>
      </Tooltip>
    </li>
  )
}
