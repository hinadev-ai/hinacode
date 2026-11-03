import { useAutoAnimate } from "@formkit/auto-animate/react"
import { startTransition, useState, useTransition } from "react"
import { type ScheduledMessage, type Thread, toCheckoutTarget } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { promptWithComments } from "../lib/lineComments.ts"
import { listMotion } from "../lib/listMotion.ts"
import { callPromise } from "../lib/rpc.ts"
import { formatSnoozeTime } from "../lib/snooze.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useDrafts } from "../stores/drafts.ts"
import { ActivityRow } from "./ActivityRow.tsx"
import { AlertIcon, CalendarIcon, ClockIcon, CloseIcon, HourglassFillIcon, PencilIcon } from "@hinacode/icons"
import { QueueAction } from "./QueueBar.tsx"
import type { TimeChoice } from "./TimePicker.tsx"
import { TimePickerDialog } from "./TimePickerDialog.tsx"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

const limitResetChoice = (thread: Thread) => {
  const reset = thread.status === "limited" ? thread.usageLimit?.reset : null
  return (now: Date): ReadonlyArray<TimeChoice> => {
    if (reset == null || Date.parse(reset.at) <= now.getTime()) return []
    const at = new Date(reset.at)
    return [
      {
        id: "limitReset",
        label: m.schedule_at_limit_reset(),
        hint: formatSnoozeTime(at, now, getLocale()),
        at,
        icon: HourglassFillIcon,
      },
    ]
  }
}

function ScheduleTimeDialog({
  thread,
  open,
  title,
  onChoose,
  onClose,
}: {
  thread: Thread
  open: boolean
  title: string
  onChoose: (at: Date) => void
  onClose: () => void
}) {
  return (
    <TimePickerDialog
      open={open}
      title={title}
      inputLabel={m.schedule_input_label()}
      placeholder={m.schedule_placeholder()}
      icon={ClockIcon}
      extraChoices={limitResetChoice(thread)}
      onClose={onClose}
      onChoose={(at) => {
        onClose()
        if (at !== null) onChoose(at)
      }}
    />
  )
}

export function ScheduleButton({
  thread,
  unstarted,
  disabled,
  onError,
}: {
  thread: Thread
  unstarted: boolean
  disabled: boolean
  onError: (message: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [isScheduling, startScheduling] = useTransition()

  const schedule = (at: Date) => {
    const sent = useDrafts.getState().take(thread.id)
    const workspace =
      unstarted && sent.workspace
        ? { mode: sent.workspace.mode, target: toCheckoutTarget(sent.workspace.ref) }
        : undefined
    onError(null)
    startScheduling(async () => {
      await callPromise("threads.schedule", {
        threadId: thread.id,
        text: promptWithComments(sent.text, sent.comments),
        attachments: sent.attachments,
        workspace,
        sendAt: at.toISOString(),
      }).catch((cause: unknown) => {
        useDrafts.getState().restore(thread.id, sent)
        onError(errorMessage(cause))
      })
    })
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={m.schedule_send()}
              disabled={disabled || isScheduling}
              onClick={() => startTransition(() => setOpen(true))}
              className="shrink-0 rounded-full text-muted-foreground"
            />
          }
        >
          <ClockIcon aria-hidden className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{m.schedule_send()}</TooltipContent>
      </Tooltip>
      <ScheduleTimeDialog
        thread={thread}
        open={open}
        title={m.schedule_title()}
        onChoose={schedule}
        onClose={() => startTransition(() => setOpen(false))}
      />
    </>
  )
}

export function ScheduledBar({
  thread,
  onEdit,
  onError,
}: {
  thread: Thread
  onEdit: () => void
  onError: (message: string) => void
}) {
  const [listRef] = useAutoAnimate<HTMLUListElement>(listMotion)
  const [moving, setMoving] = useState<ScheduledMessage | null>(null)
  const now = new Date(useNow())
  if (thread.scheduled.length === 0) return null

  const run = async (work: () => Promise<unknown>) => {
    try {
      await work()
    } catch (cause) {
      onError(errorMessage(cause))
    }
  }

  const edit = (id: string) =>
    run(async () => {
      const message = await callPromise("threads.unschedule", { threadId: thread.id, id })
      if (message === null) return
      useDrafts.getState().restore(thread.id, {
        text: message.text,
        attachments: message.attachments,
        workspace: null,
        comments: [],
      })
      onEdit()
    })

  return (
    <>
      <ul ref={listRef} aria-label={m.scheduled_label()}>
        {thread.scheduled.map((message) => (
          <li key={message.id}>
            <ActivityRow
              actions={
                <>
                  <QueueAction
                    icon={CalendarIcon}
                    label={m.scheduled_change_time()}
                    action={async () => startTransition(() => setMoving(message))}
                  />
                  <QueueAction icon={PencilIcon} label={m.scheduled_edit()} action={() => edit(message.id)} />
                  <QueueAction
                    icon={CloseIcon}
                    label={m.scheduled_cancel()}
                    action={() => run(() => callPromise("threads.unschedule", { threadId: thread.id, id: message.id }))}
                  />
                </>
              }
            >
              {message.failure === undefined ? (
                <ClockIcon aria-hidden className="size-3.5 shrink-0" />
              ) : (
                <AlertIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
              )}
              <span className="max-w-2/3 shrink-0 truncate text-foreground" title={message.text}>
                {message.text.trim() || m.queue_attachments({ count: message.attachments.length })}
              </span>
              {message.failure === undefined ? (
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {m.scheduled_sends_at({ time: formatSnoozeTime(new Date(message.sendAt), now, getLocale()) })}
                </span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-destructive" title={message.failure}>
                  {m.scheduled_failed({ reason: message.failure })}
                </span>
              )}
            </ActivityRow>
          </li>
        ))}
      </ul>
      <ScheduleTimeDialog
        thread={thread}
        open={moving !== null}
        title={m.scheduled_change_time()}
        onChoose={(at) => {
          if (moving === null) return
          void run(() =>
            callPromise("threads.reschedule", { threadId: thread.id, id: moving.id, sendAt: at.toISOString() }),
          )
        }}
        onClose={() => startTransition(() => setMoving(null))}
      />
    </>
  )
}
