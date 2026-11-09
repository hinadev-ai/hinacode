import {
  type KeyboardEvent,
  type PointerEvent,
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { TerminalSession } from "../../shared/domain.ts"
import { terminalMention } from "../../shared/mentions.ts"
import { TERMINAL_HEIGHT_BOUNDS } from "../lib/panelSize.ts"
import { terminalLabel } from "../lib/terminalLabel.ts"
import { attachTerminal, focusTerminal, showTerminal, terminalSelection } from "../lib/terminalScreens.ts"
import { m } from "../paraglide/messages.js"
import { useDrafts } from "../stores/drafts.ts"
import { useTerminals } from "../stores/terminals.ts"
import { useUi } from "../stores/ui.ts"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx"
import { Button } from "./ui/button.tsx"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "./ui/context-menu.tsx"
import { DropdownMenuItem } from "./ui/dropdown-menu.tsx"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx"
import { AtIcon, ChatIcon, ChevronDownIcon, CloseIcon, CopyIcon, PlusIcon, TerminalIcon } from "@hinacode/icons"

const MIN_HEIGHT = TERMINAL_HEIGHT_BOUNDS.min
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
      action={() => useTerminals.getState().toggle(threadId)}
    >
      <TerminalIcon aria-hidden />
    </Button>
  )
}

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
  const [confirmClose, setConfirmClose] = useState<{ session: TerminalSession; name: string } | null>(null)

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
          <TabsList
            variant="line"
            aria-label={m.terminal_sessions()}
            className="min-w-0 overflow-x-auto overflow-y-hidden"
          >
            {sessions.map((session, index) => (
              <SessionTab
                key={session.id}
                session={session}
                name={terminalLabel(session, index)}
                onClose={() => {
                  const name = terminalLabel(session, index)
                  if (session.command === null) void terminals().close(threadId, session.id)
                  else startTransition(() => setConfirmClose({ session, name }))
                }}
              />
            ))}
          </TabsList>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={m.terminal_new()}
            title={m.terminal_new()}
            action={() => terminals().openSession(threadId)}
          >
            <PlusIcon aria-hidden />
          </Button>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={m.terminal_hide()}
            title={m.terminal_hide()}
            onClick={hide}
          >
            <ChevronDownIcon aria-hidden />
          </Button>
        </div>
        {error && (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {m.terminal_failed({ message: error })}
          </p>
        )}
        {sessions.map((session) => (
          <TabsContent key={session.id} value={session.id} keepMounted className="min-h-0 data-hidden:hidden">
            <TerminalScreen threadId={threadId} id={session.id} active={session.id === activeId} />
          </TabsContent>
        ))}
      </Tabs>
      <CloseRunningDialog
        target={confirmClose}
        onCancel={() => startTransition(() => setConfirmClose(null))}
        onClose={(session) => {
          startTransition(() => setConfirmClose(null))
          void terminals().close(threadId, session.id)
        }}
      />
    </section>
  )
}

interface CloseRunningDialogProps {
  readonly target: { readonly session: TerminalSession; readonly name: string } | null
  readonly onCancel: () => void
  readonly onClose: (session: TerminalSession) => void
}

function CloseRunningDialog({ target, onCancel, onClose }: CloseRunningDialogProps) {
  const command = target?.session.command
  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.terminal_close_running_title({ name: target?.name ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>
            {command ? m.terminal_close_running_body({ command }) : m.terminal_close_running_body_unknown()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => target && onClose(target.session)}>
            {m.terminal_close_running_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function SessionTab({ session, name, onClose }: { session: TerminalSession; name: string; onClose: () => void }) {
  const exited = session.status === "exited"
  return (
    <div className="group/session flex items-center">
      <TabsTrigger value={session.id} className="h-6 flex-none gap-1.5 px-2 text-xs">
        {name}
        {session.command && (
          <span className="max-w-40 truncate font-mono text-muted-foreground" title={session.command}>
            {session.command}
          </span>
        )}
        {exited && <span className="text-muted-foreground">{m.terminal_tab_exited()}</span>}
      </TabsTrigger>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={m.terminal_close({ name })}
        title={m.terminal_close({ name })}
        onClick={onClose}
      >
        <CloseIcon aria-hidden />
      </Button>
    </div>
  )
}

const fencedText = (text: string) => {
  const longestRun = Math.max(2, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length))
  const fence = "`".repeat(longestRun + 1)
  return `${fence}text\n${text.replace(/\n+$/, "")}\n${fence}`
}

function TerminalScreen({ threadId, id, active }: { threadId: string; id: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const focusAfterClose = useRef<"terminal" | "composer">("terminal")

  useLayoutEffect(() => attachTerminal(id, ref.current!), [id])

  useEffect(() => {
    showTerminal(id, active)
    if (active) focusTerminal(id)
  }, [id, active])

  const toComposer = (append: (drafts: ReturnType<typeof useDrafts.getState>) => void) => {
    append(useDrafts.getState())
    focusAfterClose.current = "composer"
  }

  const restoreFocus = () => {
    if (focusAfterClose.current === "composer") useUi.getState().requestComposerFocus()
    else focusTerminal(id)
    focusAfterClose.current = "terminal"
  }

  return (
    <ContextMenu
      onOpenChange={(open) => open && setSelection(terminalSelection(id))}
      onOpenChangeComplete={(open) => !open && restoreFocus()}
    >
      <ContextMenuTrigger
        render={
          <div
            ref={ref}
            className="h-full focus-within:outline-1 focus-within:-outline-offset-1 focus-within:outline-ring/50"
          />
        }
      />
      <ContextMenuContent finalFocus={false}>
        {selection !== null && (
          <>
            <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(selection)}>
              <CopyIcon aria-hidden />
              {m.context_menu_copy()}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => toComposer((drafts) => drafts.appendBlock(threadId, fencedText(selection)))}
            >
              <ChatIcon aria-hidden />
              {m.terminal_send_selection()}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onClick={() => toComposer((drafts) => drafts.appendText(threadId, terminalMention(id)))}>
          <AtIcon aria-hidden />
          {m.terminal_mention()}
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

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
