import { cn } from "cn"
import { type KeyboardEvent, useEffect, useRef } from "react"
import { RiAddLine, RiCloseLine, RiGlobalLine } from "react-icons/ri"
import type { Thread } from "../../../shared/domain.ts"
import { m } from "../../paraglide/messages.js"
import { type BrowserTab, selectBrowserTabs, useBrowserTabs } from "../../stores/browserTabs.ts"
import { Button } from "../ui/button.tsx"

export const browserTabId = (threadId: string, tabId: string) => `browser-tab-${threadId}-${tabId}`
export const browserPanelId = (threadId: string, tabId: string) => `browser-page-${threadId}-${tabId}`

const tabLabel = (tab: BrowserTab) =>
  tab.title || (tab.url && (URL.parse(tab.url)?.host || tab.url)) || m.browser_new_tab()

/**
 * The Browser view's header: a horizontal WAI-ARIA tablist with automatic activation, since a hidden tab shows
 * without a reload. Arrow keys switch tabs and Delete closes the focused one.
 */
export function BrowserTabStrip({ thread }: { thread: Thread }) {
  const threadId = thread.id
  const { tabs, activeId } = useBrowserTabs(selectBrowserTabs(threadId))
  const keyboardMove = useRef(false)

  useEffect(() => {
    if (!keyboardMove.current) return
    keyboardMove.current = false
    document.getElementById(browserTabId(threadId, activeId))?.focus()
  }, [threadId, activeId])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const store = useBrowserTabs.getState()
    const index = tabs.findIndex((tab) => tab.id === activeId)
    if (event.key === "Delete") {
      event.preventDefault()
      keyboardMove.current = true
      store.closeTab(threadId, activeId)
      return
    }
    const target = {
      ArrowRight: tabs[(index + 1) % tabs.length],
      ArrowLeft: tabs.at(index - 1),
      Home: tabs[0],
      End: tabs.at(-1),
    }[event.key]
    if (!target) return
    event.preventDefault()
    keyboardMove.current = true
    store.selectTab(threadId, target.id)
  }

  const closable = tabs.length > 1 || tabs[0]!.url !== null

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- in the WAI-ARIA tabs pattern the tabs take focus, not the list. */}
      <div
        role="tablist"
        aria-label={m.browser_tabs()}
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((tab) => (
          <Tab key={tab.id} threadId={threadId} tab={tab} selected={tab.id === activeId} closable={closable} />
        ))}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={m.browser_new_tab()}
        title={m.browser_new_tab()}
        onClick={() => useBrowserTabs.getState().openTab(threadId)}
      >
        <RiAddLine aria-hidden />
      </Button>
    </div>
  )
}

interface TabProps {
  readonly threadId: string
  readonly tab: BrowserTab
  readonly selected: boolean
  readonly closable: boolean
}

function Tab({ threadId, tab, selected, closable }: TabProps) {
  const label = tabLabel(tab)
  const close = () => useBrowserTabs.getState().closeTab(threadId, tab.id)
  return (
    <div
      className={cn(
        "group relative flex h-8 w-44 min-w-24 shrink items-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        selected && "bg-muted text-foreground hover:bg-muted",
      )}
    >
      <button
        type="button"
        role="tab"
        id={browserTabId(threadId, tab.id)}
        aria-selected={selected}
        aria-controls={browserPanelId(threadId, tab.id)}
        tabIndex={selected ? 0 : -1}
        title={label}
        onClick={() => useBrowserTabs.getState().selectTab(threadId, tab.id)}
        onAuxClick={(event) => {
          if (event.button === 1 && closable) close()
        }}
        className={cn(
          "pressable flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          closable ? "pr-7" : "pr-2.5",
        )}
      >
        <RiGlobalLine aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {closable && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={m.browser_close_tab({ title: label })}
          title={m.browser_close_tab({ title: label })}
          onClick={close}
          className={cn(
            "absolute right-1 flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground",
            !selected && "invisible group-hover:visible",
          )}
        >
          <RiCloseLine aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  )
}
