import { useAutoAnimate } from "@formkit/auto-animate/react"
import type { IconType } from "react-icons"
import { RiCloseLine, RiCornerDownRightLine, RiPencilLine, RiShieldCheckLine, RiTimeLine } from "react-icons/ri"
import type { QueuedMessage, Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useDrafts } from "../stores/drafts.ts"
import { ActivityRow } from "./ActivityRow.tsx"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

const summaryOf = (message: QueuedMessage) =>
  message.text.trim() || m.queue_attachments({ count: String(message.attachments.length) })

export function QueueBar({
  thread,
  onEdit,
  onError,
}: {
  thread: Thread
  onEdit: () => void
  onError: (message: string) => void
}) {
  const [listRef] = useAutoAnimate<HTMLUListElement>({ duration: 150 })
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

  const remove = (id: string) => take(id).catch((cause: unknown) => onError(errorMessage(cause)))

  return (
    <ul ref={listRef} aria-label={m.queue_label()}>
      {thread.queue.map((message) => (
        <li key={message.id}>
          <ActivityRow
            actions={
              <>
                <QueueAction
                  icon={RiCornerDownRightLine}
                  label={m.queue_steer_now()}
                  onClick={() => steerNow(message.id)}
                />
                <QueueAction icon={RiPencilLine} label={m.queue_edit()} onClick={() => edit(message.id)} />
                <QueueAction icon={RiCloseLine} label={m.queue_remove()} onClick={() => remove(message.id)} />
              </>
            }
          >
            {message.steer ? (
              <RiShieldCheckLine aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <RiTimeLine aria-hidden className="size-3.5 shrink-0" />
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

function QueueAction({ icon: Icon, label, onClick }: { icon: IconType; label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={onClick}
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
