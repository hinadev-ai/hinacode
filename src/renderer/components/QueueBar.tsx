import { useAutoAnimate } from "@formkit/auto-animate/react"
import type { IconType } from "react-icons"
import { RiCloseLine, RiCornerDownRightLine, RiPencilLine, RiTimeLine } from "react-icons/ri"
import type { QueuedMessage, Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useDrafts } from "../stores/drafts.ts"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

const summaryOf = (message: QueuedMessage) =>
  message.text.trim() || m.queue_attachments({ count: String(message.attachments.length) })

/** Messages waiting for the running turn, above the composer. Each one can jump the queue or go back to the draft. */
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

  /** Null when the runner already sent it, so nothing is sent or restored twice. */
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
    <ul
      ref={listRef}
      aria-label={m.queue_label()}
      className="flex animate-fade-in flex-col gap-0.5 px-1 pb-1.5 text-xs"
    >
      {thread.queue.map((message) => (
        <li key={message.id} className="flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pl-1">
          <RiTimeLine aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{summaryOf(message)}</span>
          <QueueAction icon={RiCornerDownRightLine} label={m.queue_steer_now()} onClick={() => steerNow(message.id)} />
          <QueueAction icon={RiPencilLine} label={m.queue_edit()} onClick={() => edit(message.id)} />
          <QueueAction icon={RiCloseLine} label={m.queue_remove()} onClick={() => remove(message.id)} />
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
