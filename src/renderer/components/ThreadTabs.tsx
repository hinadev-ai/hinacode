import { Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef } from "react"
import { flushSync } from "react-dom"
import { RiCloseLine } from "react-icons/ri"
import type { Thread } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { StatusIndicator, useThreadRowState } from "./SidebarThreadList.tsx"
import { Button } from "./ui/button.tsx"

/** The threads the user keeps open, above the open one. It shows once they keep a second thread open. */
export function ThreadTabs({ threadId }: { threadId: string }) {
  const navigate = useNavigate()
  const byId = useThreads((state) => state.byId)
  const threads = useUi((state) => state.tabThreadIds).flatMap((id) => byId[id] ?? [])
  const navRef = useRef<HTMLElement>(null)

  useEffect(() => {
    navRef.current?.querySelector(`[data-thread-id="${threadId}"]`)?.scrollIntoView({ block: "nearest" })
  }, [threadId])

  if (threads.length < 2) return null

  const close = (closing: string) => {
    const hadFocus = navRef.current?.contains(document.activeElement) ?? false
    let next: string | undefined
    flushSync(() => {
      next = useUi.getState().closeThreadTab(closing, (id) => id in byId)
    })
    const opened =
      closing === threadId && next
        ? navigate({ to: "/thread/$threadId", params: { threadId: next } })
        : Promise.resolve()
    if (!hadFocus) return
    // The closed tab took focus with it. Keyboard users land on the tab that took over, or the composer once the strip hides.
    const tab = navRef.current?.querySelector<HTMLElement>(`a[data-thread-id="${next ?? threadId}"]`)
    if (tab) tab.focus()
    else void opened.then(() => useUi.getState().requestComposerFocus())
  }

  return (
    <nav
      ref={navRef}
      aria-label={m.thread_tabs_label()}
      className="flex h-9 shrink-0 overflow-x-auto overscroll-x-contain bg-sidebar [scrollbar-width:none] mask-r-from-[calc(100%-1.5rem)]"
    >
      {threads.map((thread) => (
        <ThreadTab key={thread.id} thread={thread} active={thread.id === threadId} onClose={() => close(thread.id)} />
      ))}
      {/*
        Inactive tabs and this filler draw the bottom border, so the active tab opens into its thread. The filler
        also takes the edge fade, which hints at tabs scrolled out of view.
      */}
      <div aria-hidden className="min-w-6 flex-1 border-b border-border" />
    </nav>
  )
}

interface ThreadTabProps {
  readonly thread: Thread
  readonly active: boolean
  readonly onClose: () => void
}

function ThreadTab({ thread, active, onClose }: ThreadTabProps) {
  const state = useThreadRowState(thread)
  return (
    <div
      data-active={active}
      className="group/tab relative flex max-w-56 min-w-32 flex-1 basis-0 items-center border-r border-b border-border text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:border-b-transparent data-[active=true]:bg-background data-[active=true]:text-foreground"
    >
      <Link
        to="/thread/$threadId"
        params={{ threadId: thread.id }}
        data-thread-id={thread.id}
        draggable={false}
        onAuxClick={(event) => {
          if (event.button !== 1) return
          event.preventDefault()
          onClose()
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-2 pr-8 pl-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ProviderIcon provider={thread.provider} />
        <span dir="auto" className="min-w-0 flex-1 truncate" title={thread.title}>
          {thread.title}
        </span>
        <StatusIndicator state={state} />
      </Link>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={m.thread_tabs_close({ title: thread.title })}
        onClick={onClose}
        className="absolute right-1.5 opacity-0 group-hover/tab:opacity-100 group-data-[active=true]/tab:opacity-100 focus-visible:opacity-100"
      >
        <RiCloseLine aria-hidden />
      </Button>
    </div>
  )
}
