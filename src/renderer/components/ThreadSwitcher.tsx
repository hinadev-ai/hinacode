import { useAtomValue } from "@effect/atom-react"
import { useNavigate, useParams } from "@tanstack/react-router"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useEffectEvent } from "react"
import type { Thread } from "../../shared/domain.ts"
import { projectsAtom } from "../lib/rpc.ts"
import type { ThreadSwitcher as Switcher } from "../lib/threadSwitcher.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { StatusIndicator, useThreadRowState } from "./SidebarThreadList.tsx"

/** The Ctrl+Tab overlay. Letting go of the modifier opens the highlighted thread. */
export function ThreadSwitcher() {
  const switcher = useUi((state) => state.threadSwitcher)
  return switcher && <SwitcherList switcher={switcher} />
}

function SwitcherList({ switcher }: { switcher: Switcher }) {
  const navigate = useNavigate()
  const { threadId: openThreadId = null } = useParams({ strict: false })
  const byId = useThreads((state) => state.byId)
  const threads = switcher.threadIds.flatMap((id) => byId[id] ?? [])
  const highlighted = switcher.threadIds[switcher.index]

  const choose = (threadId: string | undefined) => {
    useUi.getState().closeThreadSwitcher()
    if (!threadId || threadId === openThreadId) return
    // Switching is a keyboard path, so the user lands ready to type.
    void navigate({ to: "/thread/$threadId", params: { threadId } }).then(() => useUi.getState().requestComposerFocus())
  }

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.type === "keyup") {
      if (!event.ctrlKey && !event.metaKey && !event.altKey) choose(highlighted)
      return
    }
    if (event.key !== "Escape" && event.key !== "Enter") return
    event.preventDefault()
    event.stopPropagation()
    choose(event.key === "Enter" ? highlighted : undefined)
  })
  // Leaving the window loses the modifier's keyup, so the switcher closes rather than wait for it.
  const cancel = useEffectEvent(() => choose(undefined))
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    const blur = () => cancel()
    window.addEventListener("keydown", listener, { capture: true })
    window.addEventListener("keyup", listener, { capture: true })
    window.addEventListener("blur", blur)
    return () => {
      window.removeEventListener("keydown", listener, { capture: true })
      window.removeEventListener("keyup", listener, { capture: true })
      window.removeEventListener("blur", blur)
    }
  }, [])

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12dvh]">
      {/* A quick tap opens the previous thread before the list shows, so it never flashes. */}
      <ul
        aria-label={m.thread_switcher_label()}
        className="pointer-events-auto w-full max-w-md animate-reveal rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
      >
        {threads.map((thread) => (
          <SwitcherRow
            key={thread.id}
            thread={thread}
            highlighted={thread.id === highlighted}
            current={thread.id === openThreadId}
            onChoose={() => choose(thread.id)}
          />
        ))}
      </ul>
      <p aria-live="polite" className="sr-only">
        {byId[highlighted ?? ""]?.title}
      </p>
    </div>
  )
}

interface SwitcherRowProps {
  readonly thread: Thread
  readonly highlighted: boolean
  readonly current: boolean
  readonly onChoose: () => void
}

function SwitcherRow({ thread, highlighted, current, onChoose }: SwitcherRowProps) {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const project = projects.find((candidate) => candidate.id === thread.projectId)?.name
  const state = useThreadRowState(thread)
  return (
    <li>
      <button
        type="button"
        tabIndex={-1}
        aria-current={current ? "page" : undefined}
        onClick={onChoose}
        className={cn(
          "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm outline-none",
          highlighted && "bg-accent text-accent-foreground inset-ring inset-ring-ring/50",
        )}
      >
        <ProviderIcon provider={thread.provider} />
        <span dir="auto" className="min-w-0 truncate">
          {thread.title}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{project}</span>
        {current && <span className="shrink-0 text-xs text-muted-foreground">{m.thread_switcher_current()}</span>}
        <StatusIndicator state={state} />
      </button>
    </li>
  )
}
