import { useAutoAnimate } from "@formkit/auto-animate/react"
import { listMotion } from "../lib/listMotion.ts"
import type { QueuedMessage, Thread } from "../../shared/domain.ts"
import { providerInfo } from "../../shared/providers.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useDrafts } from "../stores/drafts.ts"
import { ActivityRow } from "./ActivityRow.tsx"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"
import { ClockIcon, CloseIcon, type IconComponent, PencilIcon, ShieldIcon, SteerIcon } from "@hinacode/icons"

const summaryOf = (message: QueuedMessage) =>
  message.text.trim() || m.queue_attachments({ count: message.attachments.length })

export function QueueBar({
  thread,
  onEdit,
  onError,
}: {
  thread: Thread
  onEdit: () => void
  onError: (message: string) => void
}) {
  const [listRef] = useAutoAnimate<HTMLUListElement>(listMotion)
  if (thread.queue.length === 0) return null

  const take = (id: string) => callPromise("threads.unqueue", { threadId: thread.id, id })

  const restore = (message: QueuedMessage) => {
    useDrafts.getState().restore(thread.id, {
      text: message.text,
      attachments: message.attachments,
      workspace: null,
      comments: [],
    })
    onEdit()
  }

  const steerNow = async (id: string) => {
    let message: QueuedMessage | null = null
    try {
      message = await take(id)
      if (message === null) return
      await callPromise("threads.steer", { threadId: thread.id, text: message.text, attachments: message.attachments })
    } catch (cause) {
      if (message !== null) restore(message)
      onError(errorMessage(cause))
    }
  }

  const edit = async (id: string) => {
    try {
      const message = await take(id)
      if (message === null) return
      restore(message)
    } catch (cause) {
      onError(errorMessage(cause))
    }
  }

  const remove = async (id: string) => {
    try {
      await take(id)
    } catch (cause) {
      onError(errorMessage(cause))
    }
  }

  return (
    <ul ref={listRef} aria-label={m.queue_label()}>
      {thread.queue.map((message) => (
        <li key={message.id}>
          <ActivityRow
            actions={
              <>
                {providerInfo[thread.provider].steersRunningTurn && (
                  <QueueAction icon={SteerIcon} label={m.queue_steer_now()} action={() => steerNow(message.id)} />
                )}
                <QueueAction icon={PencilIcon} label={m.queue_edit()} action={() => edit(message.id)} />
                <QueueAction icon={CloseIcon} label={m.queue_remove()} action={() => remove(message.id)} />
              </>
            }
          >
            {message.steer ? (
              <ShieldIcon aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <ClockIcon aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="truncate text-foreground" title={summaryOf(message)}>
              {summaryOf(message)}
            </span>
            {message.steer && <span className="shrink-0 text-muted-foreground">{m.queue_after_approval()}</span>}
          </ActivityRow>
        </li>
      ))}
    </ul>
  )
}

function QueueAction({
  icon: Icon,
  label,
  action,
}: {
  icon: IconComponent
  label: string
  action: () => Promise<void>
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            action={action}
            className="text-muted-foreground"
          />
        }
      >
        <Icon aria-hidden />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
