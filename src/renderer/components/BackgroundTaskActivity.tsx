import type { BackgroundTask, BackgroundTaskKind } from "../../shared/agent.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useThreadBackgroundTasks } from "../stores/backgroundTasks.ts"
import { ActivityRow } from "./ActivityRow.tsx"
import { Button } from "./ui/button.tsx"
import { toast } from "sonner"
import { AlarmIcon, FlowIcon, type IconComponent, SpinnerIcon, StopIcon, TerminalIcon } from "@hinacode/icons"

const kinds = {
  shell: { icon: TerminalIcon, label: m.activity_background_shell },
  workflow: { icon: FlowIcon, label: m.activity_background_workflow },
  wakeup: { icon: AlarmIcon, label: m.activity_background_wakeup },
  other: { icon: SpinnerIcon, label: m.activity_background_other },
} satisfies Record<BackgroundTaskKind, { readonly icon: IconComponent; readonly label: () => string }>

export function BackgroundTaskActivity({ threadId }: { threadId: string }) {
  const tasks = useThreadBackgroundTasks(threadId)
  if (tasks.length === 0) return null
  return (
    <ul aria-label={m.activity_background_label()}>
      {tasks.map((task) => (
        <li key={task.id}>
          <BackgroundTaskRow threadId={threadId} task={task} />
        </li>
      ))}
    </ul>
  )
}

function BackgroundTaskRow({ threadId, task }: { threadId: string; task: BackgroundTask }) {
  const { icon: Icon, label: kindLabel } = kinds[task.kind]
  const label = task.label || kindLabel()
  return (
    <ActivityRow
      actions={
        task.kind === "wakeup" ? undefined : (
          <StopBackgroundTaskButton threadId={threadId} taskId={task.id} taskLabel={label} />
        )
      }
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="sr-only">{kindLabel()}</span>
      <span className="truncate text-foreground" title={label}>
        {label}
      </span>
      {task.firesAt !== undefined && (
        <time dateTime={task.firesAt} className="ml-auto shrink-0 pr-1 tabular-nums">
          {m.activity_background_wakes_at({
            time: new Date(task.firesAt).toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" }),
          })}
        </time>
      )}
    </ActivityRow>
  )
}

function StopBackgroundTaskButton({
  threadId,
  taskId,
  taskLabel,
}: {
  threadId: string
  taskId: string
  taskLabel: string
}) {
  const stop = async () => {
    try {
      await callPromise("backgroundTasks.stop", { threadId, taskId })
    } catch (cause) {
      toast.error(m.activity_background_stop_failed({ message: errorMessage(cause) }))
    }
  }
  const label = m.activity_background_stop({ label: taskLabel })
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      action={stop}
      aria-label={label}
      title={label}
      className="text-muted-foreground hover:text-foreground"
    >
      <StopIcon aria-hidden className="size-3 fill-current" />
    </Button>
  )
}
