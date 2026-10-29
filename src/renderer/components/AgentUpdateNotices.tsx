import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState, useTransition } from "react"
import { RiArrowDownCircleFill, RiCloseLine } from "react-icons/ri"
import { toast } from "sonner"
import type { AgentUpdate } from "../../shared/agent.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useDismissedUpdates } from "../stores/dismissedUpdates.ts"
import { ProviderIcon, providerLabel } from "./ProviderIcon.tsx"
import { Button } from "./ui/button.tsx"

const CHECK_EVERY_MS = 4 * 60 * 60_000

export function useAgentUpdateNotices() {
  const navigate = useNavigate()
  useEffect(() => {
    const openSettings = () => void navigate({ to: "/settings", search: { page: "models" } })
    const check = () =>
      callPromise("agents.updates", undefined)
        .then((updates) => {
          const dismissed = useDismissedUpdates.getState().byProvider
          for (const update of updates) {
            if (dismissed[update.provider] === update.latest) continue
            toast.custom((id) => <AgentUpdateNotice update={update} toastId={id} onSettings={openSettings} />, {
              id: `agent-update:${update.provider}`,
              duration: Infinity,
            })
          }
        })
        .catch((cause: unknown) => console.error(`Could not check for agent updates: ${errorMessage(cause)}`))
    void check()
    const timer = setInterval(check, CHECK_EVERY_MS)
    return () => clearInterval(timer)
  }, [navigate])
}

interface AgentUpdateNoticeProps {
  readonly update: AgentUpdate
  readonly toastId: string | number
  readonly onSettings: () => void
}

function AgentUpdateNotice({ update, toastId, onSettings }: AgentUpdateNoticeProps) {
  const [isInstalling, startInstalling] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const agent = providerLabel[update.provider]()

  const dismiss = () => {
    useDismissedUpdates.getState().dismiss(update.provider, update.latest)
    toast.dismiss(toastId)
  }

  const install = () => {
    setError(null)
    startInstalling(async () => {
      try {
        const version = await callPromise("agents.update", { provider: update.provider })
        toast.dismiss(toastId)
        toast.success(m.agent_update_done({ agent, version }))
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  return (
    <div className="relative flex w-(--width) flex-col gap-1 rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-lg">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={m.agent_update_dismiss()}
        onClick={dismiss}
        className="absolute top-2 right-2 text-muted-foreground"
      >
        <RiCloseLine aria-hidden />
      </Button>
      <p className="flex items-center gap-2 pr-6 font-medium">
        <span className="relative shrink-0">
          <ProviderIcon provider={update.provider} className="size-4" />
          <RiArrowDownCircleFill
            aria-hidden
            className="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-popover text-success"
          />
        </span>
        {m.agent_update_title({ agent, version: update.latest })}
      </p>
      <p className="text-muted-foreground">{m.agent_update_body()}</p>
      {error && (
        <p role="alert" className="text-xs break-words text-destructive">
          {error}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onSettings}>
          {m.agent_update_settings()}
        </Button>
        <Button variant="outline" size="sm" onClick={install} disabled={isInstalling}>
          {isInstalling ? m.agent_update_installing() : m.agent_update_install()}
        </Button>
      </div>
    </div>
  )
}
