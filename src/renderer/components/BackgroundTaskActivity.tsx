import type { IconType } from "react-icons"
import { RiAlarmLine, RiFlowChart, RiLoader4Line, RiStopFill, RiTerminalBoxLine } from "react-icons/ri"
import type { BackgroundTask, BackgroundTaskKind } from "../../shared/agent.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useThreadBackgroundTasks } from "../stores/backgroundTasks.ts"
import { ActivityRow } from "./ActivityRow.tsx"
import { Button } from "./ui/button.tsx"
import { toast } from "sonner"

const kinds = {
  shell: { icon: RiTerminalBoxLine, label: m.activity_background_shell },
  workflow: { icon: RiFlowChart, label: m.activity_background_workflow },
  wakeup: { icon: RiAlarmLine, label: m.activity_background_wakeup },
  other: { icon: RiLoader4Line, label: m.activity_background_other },
} satisfies Record<BackgroundTaskKind, { readonly icon: IconType; readonly label: () => string }>

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
      actions={task.kind === "wakeup" ? undefined : <StopBackgroundTaskButton threadId={threadId} task={task} />}
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

function StopBackgroundTaskButton({ threadId, task }: { threadId: string; task: BackgroundTask }) {
  const stop = async () => {
    try {
      await callPromise("backgroundTasks.stop", { threadId, taskId: task.id })
    } catch (cause) {
      toast.error(m.activity_background_stop_failed({ message: errorMessage(cause) }))
    }
  }
  const label = m.activity_background_stop({ label: task.label })
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      action={stop}
      aria-label={label}
      title={label}
      className="text-muted-foreground hover:text-foreground"
    >
      <RiStopFill aria-hidden className="size-3 fill-current" />
    </Button>
  )
}
