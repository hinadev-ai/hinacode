import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef } from "react"
import { RiAddLine, RiArrowDownSLine, RiCloseLine, RiTerminalBoxLine } from "react-icons/ri"
import type { TerminalSession } from "../../shared/domain.ts"
import { attachTerminal, focusTerminal, showTerminal } from "../lib/terminalScreens.ts"
import { m } from "../paraglide/messages.js"
import { useTerminals } from "../stores/terminals.ts"
import { useUi } from "../stores/ui.ts"
import { Button } from "./ui/button.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx"

const MIN_HEIGHT = 120
/** Room the transcript and composer keep above the drawer. */
const RESERVED_HEIGHT = 200
const KEYBOARD_STEP = 24

const terminals = () => useTerminals.getState()

export function TerminalToggle({ threadId }: { threadId: string }) {
  const open = useTerminals((state) => state.byThreadId[threadId]?.open ?? false)
  const label = open ? m.terminal_hide() : m.terminal_show()
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-expanded={open}
      onClick={() => void useTerminals.getState().toggle(threadId)}
    >
      <RiTerminalBoxLine aria-hidden />
    </Button>
  )
}

/** Shells in the thread's workspace, one tab per session, docked under the composer. */
export function TerminalDrawer({ threadId }: { threadId: string }) {
  const thread = useTerminals((state) => state.byThreadId[threadId])
  if (!thread?.open) return null
  return <OpenDrawer threadId={threadId} sessions={thread.sessions} activeId={thread.activeId} />
}

interface OpenDrawerProps {
  readonly threadId: string
  readonly sessions: ReadonlyArray<TerminalSession>
  readonly activeId: string | null
}

function OpenDrawer({ threadId, sessions, activeId }: OpenDrawerProps) {
  const height = useTerminals((state) => state.height)
  const error = useTerminals((state) => state.error)
  const sectionRef = useRef<HTMLElement>(null)

  // Clicking the drawer's chrome types into the shell, the way clicking the screen does. It is a pointer
  // shortcut only: keyboard users reach the screen's textbox with Tab.
  useEffect(() => {
    const section = sectionRef.current!
    const focusShell = (event: globalThis.MouseEvent) => {
      if (activeId && !(event.target as Element).closest("button, [role=separator], .wterm")) focusTerminal(activeId)
    }
    section.addEventListener("click", focusShell)
    return () => section.removeEventListener("click", focusShell)
  }, [activeId])

  const hide = () => {
    void terminals().toggle(threadId)
    useUi.getState().requestComposerFocus()
  }

  return (
    <section
      ref={sectionRef}
      aria-label={m.terminal_label()}
      className="relative flex shrink-0 flex-col overflow-hidden border-t border-border bg-background"
      style={{ height }}
    >
      <ResizeHandle height={height} />
      <Tabs
        value={activeId}
        onValueChange={(id: string) => terminals().setActive(threadId, id)}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex h-8 shrink-0 items-center gap-1 px-2">
          <TabsList variant="line" aria-label={m.terminal_sessions()} className="min-w-0 overflow-x-auto">
            {sessions.map((session, index) => (
              <SessionTab
                key={session.id}
                session={session}
                name={m.terminal_tab({ index: index + 1 })}
                onClose={() => void terminals().close(threadId, session.id)}
              />
            ))}
          </TabsList>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={m.terminal_new()}
            title={m.terminal_new()}
            onClick={() => void terminals().openSession(threadId)}
          >
            <RiAddLine aria-hidden />
          </Button>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={m.terminal_hide()}
            title={m.terminal_hide()}
            onClick={hide}
          >
            <RiArrowDownSLine aria-hidden />
          </Button>
        </div>
        {error && (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {m.terminal_failed({ message: error })}
          </p>
        )}
        {sessions.map((session) => (
          <TabsContent key={session.id} value={session.id} keepMounted className="min-h-0 data-hidden:hidden">
            <TerminalScreen id={session.id} active={session.id === activeId} />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  )
}

function SessionTab({ session, name, onClose }: { session: TerminalSession; name: string; onClose: () => void }) {
  const exited = session.status === "exited"
  return (
    <div className="group/session flex items-center">
      <TabsTrigger value={session.id} className="h-7 flex-none gap-1.5 px-2 text-xs">
        {name}
        {exited && <span className="text-muted-foreground">{m.terminal_tab_exited()}</span>}
      </TabsTrigger>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={m.terminal_close({ name })}
        title={m.terminal_close({ name })}
        onClick={onClose}
      >
        <RiCloseLine aria-hidden />
      </Button>
    </div>
  )
}

function TerminalScreen({ id, active }: { id: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => attachTerminal(id, ref.current!), [id])

  useEffect(() => {
    showTerminal(id, active)
    if (active) focusTerminal(id)
  }, [id, active])

  return (
    <div
      ref={ref}
      className="h-full focus-within:outline-1 focus-within:-outline-offset-1 focus-within:outline-ring/50"
    />
  )
}

/** The drawer's top edge. Drag it, or focus it and use the arrow keys. */
function ResizeHandle({ height }: { height: number }) {
  const setHeight = useTerminals((state) => state.setHeight)
  const ref = useRef<HTMLDivElement>(null)

  const maxHeight = () => {
    const column = ref.current?.parentElement?.parentElement
    return Math.max(MIN_HEIGHT, (column?.clientHeight ?? 0) - RESERVED_HEIGHT)
  }
  const resize = (next: number) => setHeight(Math.round(Math.min(maxHeight(), Math.max(MIN_HEIGHT, next))))

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const move = (moved: globalThis.PointerEvent) => resize(startHeight + startY - moved.clientY)
    const stop = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", stop)
      handle.removeEventListener("pointercancel", stop)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", stop)
    handle.addEventListener("pointercancel", stop)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") resize(height + KEYBOARD_STEP)
    else if (event.key === "ArrowDown") resize(height - KEYBOARD_STEP)
    else return
    event.preventDefault()
  }

  return (
    <div
      ref={ref}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a focusable window splitter (WAI-ARIA), which jsx-a11y does not allow on <hr>
      role="separator"
      aria-orientation="horizontal"
      aria-label={m.terminal_resize()}
      aria-valuenow={height}
      aria-valuemin={MIN_HEIGHT}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize outline-none hover:bg-ring/20 focus-visible:bg-ring/50"
    />
  )
}
