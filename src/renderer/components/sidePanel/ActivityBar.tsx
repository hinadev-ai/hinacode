import { cn } from "cn"
import { createElement, type KeyboardEvent, useRef } from "react"
import { useKeymap } from "../../keybindings/useKeybindings.ts"
import { m } from "../../paraglide/messages.js"
import { useUi } from "../../stores/ui.ts"
import { ChordKeys } from "../ChordKeys.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx"
import { type SidePanelView, viewById } from "./views.ts"

interface ActivityBarProps {
  readonly threadId: string
  readonly views: ReadonlyArray<SidePanelView>
  readonly selected: SidePanelView["id"] | null
  readonly panelId: string
}

export function ActivityBar({ threadId, views, selected, panelId }: ActivityBarProps) {
  const keymap = useKeymap()
  const listRef = useRef<HTMLDivElement>(null)
  const current = viewById(
    views,
    useUi((state) => state.sidePanelViews[threadId] ?? state.lastSidePanelView),
  ).id

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...(listRef.current?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])]
    const index = tabs.indexOf(document.activeElement as HTMLElement)
    const target = {
      ArrowDown: tabs[(index + 1) % tabs.length],
      ArrowUp: tabs.at(index - 1),
      Home: tabs[0],
      End: tabs.at(-1),
    }[event.key]
    if (!target) return
    event.preventDefault()
    target.focus()
  }

  return (
    // oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- in the WAI-ARIA tabs pattern the tabs take focus, not the list.
    <div
      ref={listRef}
      role="tablist"
      aria-label={m.panel_views()}
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-border py-2"
    >
      {views.map((view) => (
        <ActivityTab
          key={view.id}
          view={view}
          threadId={threadId}
          chord={keymap[view.commandId] ?? ""}
          selected={selected === view.id}
          focusable={current === view.id}
          panelId={panelId}
        />
      ))}
    </div>
  )
}

interface ActivityTabProps {
  readonly view: SidePanelView
  readonly threadId: string
  readonly chord: string
  readonly selected: boolean
  readonly focusable: boolean
  readonly panelId: string
}

function ActivityTab({ view, threadId, chord, selected, focusable, panelId }: ActivityTabProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- TooltipTrigger passes in the sr-only title as the label.
          <button
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={selected ? panelId : undefined}
            tabIndex={focusable ? 0 : -1}
            onClick={() => useUi.getState().toggleView(threadId, view.id)}
            className={cn(
              "pressable relative flex size-9 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              selected && "bg-muted text-foreground",
            )}
          />
        }
      >
        {createElement(view.icon, { "aria-hidden": true, className: "size-[1.125rem]" })}
        <span className="sr-only">{view.title()}</span>
        {view.badge && <ViewBadge useCount={view.badge} threadId={threadId} />}
      </TooltipTrigger>
      <TooltipContent side="left">
        {view.title()}
        {chord && <ChordKeys chord={chord} />}
      </TooltipContent>
    </Tooltip>
  )
}

function ViewBadge({ useCount, threadId }: { useCount: (threadId: string) => number; threadId: string }) {
  // oxlint-disable-next-line react/rules-of-hooks -- the registry is a module constant, so each keyed badge always gets the same hook.
  const count = useCount(threadId)
  if (count === 0) return null
  return (
    <span className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-working px-1 text-2xs font-medium text-background tabular-nums">
      <span aria-hidden>{count}</span>
      <span className="sr-only">{m.agents_running_count({ count })}</span>
    </span>
  )
}
