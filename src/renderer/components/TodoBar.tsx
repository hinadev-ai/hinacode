import { useMemo, useState } from "react"
import type { IconType } from "react-icons"
import {
  RiArrowDownSLine,
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiLoader4Line,
} from "react-icons/ri"
import type { Message, Thread } from "../../shared/domain.ts"
import { latestTodos, type Todo, type TodoStatus } from "../lib/todos.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { useMessages } from "../stores/messages.ts"

const NO_MESSAGES: ReadonlyArray<Message> = []

const statusIcon: Record<TodoStatus, { readonly icon: IconType; readonly className: string }> = {
  pending: { icon: RiCheckboxBlankCircleLine, className: "text-muted-foreground" },
  in_progress: { icon: RiLoader4Line, className: "animate-spin text-foreground motion-reduce:animate-none" },
  completed: { icon: RiCheckboxCircleLine, className: "text-emerald-600 dark:text-emerald-500" },
  cancelled: { icon: RiCloseCircleLine, className: "text-muted-foreground" },
}

function TodoRow({ todo }: { todo: Todo }) {
  const { icon: Icon, className } = statusIcon[todo.status]
  return (
    <li className="flex min-w-0 items-start gap-1.5">
      <Icon aria-hidden className={cn("mt-px size-3.5 shrink-0", className)} />
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
 * The agent's own task list (Claude tasks, Codex plan, Muse todos), above the composer while any of
 * it is unfinished. Collapsed it shows progress and what is running now; expanding lists every task.
 */
export function TodoBar({ thread }: { thread: Thread }) {
  const messages = useMessages((state) => {
    const history = state.byThread[thread.id]
    return history?.status === "ready" ? history.messages : NO_MESSAGES
  })
  const todos = useMemo(() => latestTodos(messages), [messages])
  const [expanded, setExpanded] = useState(false)

  const done = todos.filter((todo) => todo.status === "completed").length
  const settled = todos.every((todo) => todo.status === "completed" || todo.status === "cancelled")
  const busy = thread.status === "running" || thread.status === "awaiting_approval"
  if (todos.length === 0 || (settled && !busy)) return null

  const current = todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending")

  return (
    <div className="animate-fade-in px-1 pb-1.5 text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={m.composer_todos_label()}
        onClick={() => setExpanded((open) => !open)}
        className="pressable flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {m.composer_todos_progress({ done: String(done), total: String(todos.length) })}
        </span>
        {!expanded && current && (
          <span className="flex min-w-0 items-center gap-1.5">
            {(() => {
              const { icon: Icon, className } = statusIcon[current.status]
              return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />
            })()}
            <span className="truncate">{current.text}</span>
          </span>
        )}
        <RiArrowDownSLine
          aria-hidden
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <ul aria-label={m.composer_todos_label()} className="flex flex-col gap-1 px-1 pt-1.5">
          {todos.map((todo, index) => (
            <TodoRow key={`${index}-${todo.text}`} todo={todo} />
          ))}
        </ul>
      )}
    </div>
  )
}
