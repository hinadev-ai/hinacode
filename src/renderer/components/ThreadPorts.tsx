import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { useState, useTransition } from "react"
import { RiCloseCircleLine } from "react-icons/ri"
import type { OpenPort } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise, threadPortsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

/** Listening TCP ports, as the body of a panel section: opened from the thread's workspace or by its agent, refreshed every 2s. */
export function ThreadPorts({ threadId }: { threadId: string }) {
  const ports = useAtomValue(threadPortsAtom(threadId))
  const refresh = useAtomRefresh(threadPortsAtom(threadId))
  const [killError, setKillError] = useState<string | null>(null)
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })

  const failed = (message: string) => (
    <div role="alert" className="flex items-center gap-2">
      <p className="text-xs text-destructive">{m.ports_failed({ message })}</p>
      <Button variant="outline" size="xs" onClick={refresh}>
        {m.sidebar_retry()}
      </Button>
    </div>
  )

  return (
    <div className="flex flex-col gap-1.5">
      {AsyncResult.builder(ports)
        .onInitial(() => <p className="text-xs text-muted-foreground">{m.ports_loading()}</p>)
        .onSuccess((list) =>
          list.length === 0 ? (
            <p className="text-xs text-muted-foreground">{m.ports_empty()}</p>
          ) : (
            <ul ref={listRef} className="flex flex-col">
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
        .onError((error) => failed(errorMessage(error)))
        .orElse(() => failed(""))}
      {killError && (
        <p role="alert" className="text-xs text-destructive">
          {killError}
        </p>
      )}
    </div>
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
        onKillFailed(errorMessage(cause))
      }
    })
  }

  const process = m.ports_process({ command: port.command, pid: String(port.pid) })
  const label = armed
    ? m.ports_kill_confirm({ command: port.command })
    : m.ports_kill({ command: port.command, port: String(port.port) })

  return (
    <li className="group/port flex h-7 items-center gap-2 text-xs">
      <span className="w-12 shrink-0 font-mono text-[11px] tabular-nums">:{port.port}</span>
      <span
        className="min-w-0 flex-1 truncate text-muted-foreground"
        title={[process, port.cwd].filter(Boolean).join("\n")}
      >
        {process}
      </span>
      <Tooltip open={armed || hovered} onOpenChange={setHovered}>
        <TooltipTrigger
          render={
            <Button
              variant={armed ? "destructive" : "ghost"}
              size="icon-xs"
              className={
                armed
                  ? undefined
                  : "text-muted-foreground opacity-0 group-hover/port:opacity-100 focus-visible:opacity-100"
              }
              aria-label={label}
              disabled={pending}
              onClick={onClick}
              onBlur={() => setArmed(false)}
            />
          }
        >
          <RiCloseCircleLine aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </li>
  )
}
