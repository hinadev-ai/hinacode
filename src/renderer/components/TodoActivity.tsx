import { useState } from "react"
import type { Message, Thread } from "../../shared/domain.ts"
import { latestTodos, type Todo, type TodoStatus } from "../lib/todos.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { useMessages } from "../stores/messages.ts"
import { ActivityRow } from "./ActivityRow.tsx"
import { CheckCircleIcon } from "./icons/CheckCircleIcon.tsx"
import { ChevronDownIcon } from "./icons/ChevronDownIcon.tsx"
import { CircleIcon } from "./icons/CircleIcon.tsx"
import type { IconComponent } from "./icons/Icon.tsx"
import { SpinnerIcon } from "./icons/SpinnerIcon.tsx"
import { XCircleIcon } from "./icons/XCircleIcon.tsx"

const NO_MESSAGES: ReadonlyArray<Message> = []

const statusIcon: Record<TodoStatus, { readonly icon: IconComponent; readonly className: string }> = {
  pending: { icon: CircleIcon, className: "text-muted-foreground" },
  in_progress: { icon: SpinnerIcon, className: "animate-spin motion-reduce:animate-none" },
  completed: { icon: CheckCircleIcon, className: "text-muted-foreground" },
  cancelled: { icon: XCircleIcon, className: "text-muted-foreground" },
}

function TodoIcon({ status, className }: { status: TodoStatus; className?: string }) {
  const { icon: Icon, className: statusClassName } = statusIcon[status]
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", statusClassName, className)} />
}

function TodoRow({ todo }: { todo: Todo }) {
  return (
    <li className="flex min-w-0 items-start gap-1.5">
      <TodoIcon status={todo.status} className="mt-px" />
      <span
        className={cn(
          "min-w-0",
          todo.status === "completed" && "text-muted-foreground line-through",
          todo.status === "cancelled" && "text-muted-foreground",
        )}
      >
        {todo.text}
      </span>
    </li>
  )
}

/**
 * The agent's own task list (Claude tasks, Codex plan, Muse todos) while any of it is unfinished. Collapsed it
 * shows progress and what is running now; expanding lists every task.
 */
export function TodoActivity({ thread }: { thread: Thread }) {
  const messages = useMessages((state) => {
    const history = state.byThread[thread.id]
    return history?.status === "ready" ? history.messages : NO_MESSAGES
  })
  const todos = latestTodos(messages)
  const [expanded, setExpanded] = useState(false)

  const done = todos.filter((todo) => todo.status === "completed").length
  const settled = todos.every((todo) => todo.status === "completed" || todo.status === "cancelled")
  const busy = thread.status === "running" || thread.status === "awaiting_approval"
  if (todos.length === 0 || (settled && !busy)) return null

  const current = todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending")

  return (
    <div>
      <ActivityRow label={m.composer_todos_label()} expanded={expanded} onClick={() => setExpanded((open) => !open)}>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {m.composer_todos_progress({ done: String(done), total: String(todos.length) })}
        </span>
        {!expanded && current && (
          <span className="flex min-w-0 items-center gap-1.5">
            <TodoIcon status={current.status} />
            <span className="truncate">{current.text}</span>
          </span>
        )}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </ActivityRow>
      {expanded && (
        // Its own bound, so a long plan scrolls instead of pushing the other sections out of view.
        <ul
          aria-label={m.composer_todos_label()}
          className="flex max-h-[20cqh] flex-col gap-1 overflow-y-auto px-1 pt-1 pb-1.5 text-xs"
        >
          {todos.map((todo, index) => (
            <TodoRow key={`${index}-${todo.text}`} todo={todo} />
          ))}
        </ul>
      )}
    </div>
  )
}
