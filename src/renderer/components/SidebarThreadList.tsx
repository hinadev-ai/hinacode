import {
  Accessibility,
  type Draggable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom"
import { isSortable } from "@dnd-kit/dom/sortable"
import { move } from "@dnd-kit/helpers"
import { DragDropProvider } from "@dnd-kit/react"
import { useSortable } from "@dnd-kit/react/sortable"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { Link, useNavigate, useParams } from "@tanstack/react-router"
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  startTransition,
  useActionState,
  useMemo,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import {
  RiCheckboxCircleLine,
  RiDeleteBinLine,
  RiDraggable,
  RiGitBranchLine,
  RiMoreFill,
  RiPencilLine,
} from "react-icons/ri"
import { useShallow } from "zustand/react/shallow"
import type { Thread, ThreadStatus } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { selectProjectThreads, useThreads } from "../stores/threads.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { SettleDialog, useActiveWorktree } from "./SettleDialog.tsx"
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx"
import { Input } from "./ui/input.tsx"

type DragDropPlugins = NonNullable<ComponentProps<typeof DragDropProvider>["plugins"]>

const titleOf = (id: unknown) => useThreads.getState().byId[String(id)]?.title ?? ""

/** Screen reader instructions and announcements for one project's list, in the current locale. */
const accessibility = (projectId: string) => {
  const position = (source: Draggable) => ({
    position: String((isSortable(source) ? source.index : 0) + 1),
    total: String(selectProjectThreads(projectId)(useThreads.getState()).length),
  })
  return Accessibility.configure({
    screenReaderInstructions: { draggable: m.sidebar_drag_instructions() },
    announcements: {
      dragstart: ({ operation: { source } }: DragStartEvent) =>
        source && m.sidebar_drag_start({ title: titleOf(source.id) }),
      dragover: ({ operation: { source } }: DragOverEvent) =>
        source && m.sidebar_drag_over({ title: titleOf(source.id), ...position(source) }),
      dragend: ({ operation: { source }, canceled }: DragEndEvent) => {
        if (!source) return undefined
        if (canceled) return m.sidebar_drag_cancel({ title: titleOf(source.id) })
        return m.sidebar_drag_end({ title: titleOf(source.id), ...position(source) })
      },
    },
  })
}

/**
 * Rows drag by the whole row with the mouse (after a few pixels, so clicks still navigate) and by
 * the grip handle from the keyboard, which is dnd-kit's default keyboard sensor.
 */
const sensors = [
  PointerSensor.configure({
    activatorElements: (source) => [source.element],
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 4 })],
    preventActivation: (event, source) =>
      event.target instanceof Element &&
      !source.handle?.contains(event.target) &&
      event.target.closest("button, input") !== null,
  }),
  KeyboardSensor,
]

/** Threads of one project in their saved order, reorderable by drag. */
export function SidebarThreadList({ projectId }: { projectId: string }) {
  const threads = useThreads(useShallow(selectProjectThreads(projectId)))
  const [listRef, setAnimate] = useAutoAnimate<HTMLUListElement>({ duration: 150 })
  const plugins = useMemo<DragDropPlugins>(
    () => (defaults) => [...defaults.filter((plugin) => plugin !== Accessibility), accessibility(projectId)],
    [projectId],
  )
  const [reorderError, setReorderError] = useState<string | null>(null)

  const save = async (ordered: ReadonlyArray<Thread>) => {
    const moved = ordered.flatMap((thread, index) =>
      thread.sortIndex === index ? [] : [{ ...thread, sortIndex: index }],
    )
    const { upsert } = useThreads.getState()
    // dnd-kit already shows the new order; commit it to the store before animations resume.
    flushSync(() => moved.forEach(upsert))
    try {
      const saved = await Promise.all(
        moved.map((thread) => callPromise("threads.update", { id: thread.id, sortIndex: thread.sortIndex })),
      )
      saved.forEach(upsert)
      setReorderError(null)
    } catch (cause) {
      threads.forEach(upsert)
      setReorderError(errorMessage(cause))
    }
  }

  return (
    <>
      <DragDropProvider
        plugins={plugins}
        sensors={sensors}
        onDragStart={() => setAnimate(false)}
        onDragEnd={(event) => {
          if (!event.canceled) void save(move(threads, event))
          setAnimate(true)
        }}
      >
        <ul ref={listRef} className="flex flex-col gap-0.5 py-0.5 pl-5">
          {threads.length === 0 && (
            <li className="px-2 py-1 text-xs text-muted-foreground">{m.sidebar_no_threads()}</li>
          )}
          {threads.map((thread, index) => (
            <ThreadRow key={thread.id} thread={thread} index={index} group={projectId} />
          ))}
        </ul>
      </DragDropProvider>
      {reorderError && (
        <p role="alert" className="px-2 py-1 pl-7 text-xs text-destructive">
          {m.sidebar_reorder_failed({ message: reorderError })}
        </p>
      )}
    </>
  )
}

type RowMode = "idle" | "renaming" | "settle" | "delete"

interface ThreadRowProps {
  readonly thread: Thread
  readonly index: number
  readonly group: string
}

function ThreadRow({ thread, index, group }: ThreadRowProps) {
  const { ref, handleRef, isDragSource } = useSortable({ id: thread.id, index, group })
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState<RowMode>("idle")
  // Menu items queue their mode and apply it once the menu has closed and handed focus back.
  const [queued, setQueued] = useState<RowMode | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const worktree = useActiveWorktree(thread)
  const busy = thread.status === "running" || thread.status === "awaiting_approval"
  const canSettle = thread.status !== "settled" || worktree !== undefined

  const queue = (next: RowMode) => () => setQueued(next)
  const closeDialog = (open: boolean) => {
    if (!open) setMode("idle")
  }
  // The menu trigger only exists outside rename mode, so render it before handing focus back.
  const finishRename = () => {
    flushSync(() => setMode("idle"))
    menuTriggerRef.current?.focus()
  }

  return (
    <li
      ref={ref}
      data-dragging={isDragSource}
      data-menu-open={menuOpen}
      className="group/thread relative rounded-md data-[dragging=true]:bg-sidebar-accent data-[dragging=true]:opacity-80"
    >
      {mode === "renaming" ? (
        <RenameInput thread={thread} onDone={finishRename} />
      ) : (
        <Link
          to="/thread/$threadId"
          params={{ threadId: thread.id }}
          draggable={false}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenuOpen(true)
          }}
          className="flex items-center gap-2 rounded-md py-1 pr-2 pl-2 text-sm text-sidebar-foreground/80 outline-none group-hover/thread:pr-14 group-has-[a:focus-visible,button:focus]/thread:pr-14 group-data-[menu-open=true]/thread:pr-14 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-accent-foreground"
        >
          <ProviderIcon provider={thread.provider} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate" title={thread.title}>
              {thread.title}
            </span>
            {thread.worktreeId && <WorktreeBranch worktreeId={thread.worktreeId} />}
          </span>
          <StatusDot status={thread.status} />
        </Link>
      )}

      {mode !== "renaming" && (
        <div className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 group-hover/thread:opacity-100 group-has-[a:focus-visible]/thread:opacity-100 focus-within:opacity-100 group-data-[menu-open=true]/thread:opacity-100">
          <Button
            ref={handleRef}
            variant="ghost"
            size="icon-xs"
            aria-label={m.sidebar_thread_reorder({ title: thread.title })}
            aria-roledescription={m.sidebar_thread_reorder_role()}
            className="cursor-grab"
          >
            <RiDraggable aria-hidden />
          </Button>
          <DropdownMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onOpenChangeComplete={(open) => {
              if (open || !queued) return
              setMode(queued)
              setQueued(null)
            }}
          >
            <DropdownMenuTrigger
              ref={menuTriggerRef}
              render={
                <Button variant="ghost" size="icon-xs" aria-label={m.sidebar_thread_actions({ title: thread.title })} />
              }
            >
              <RiMoreFill aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={queue("renaming")}>
                <RiPencilLine aria-hidden />
                {m.sidebar_thread_rename()}
              </DropdownMenuItem>
              {canSettle && (
                <DropdownMenuItem disabled={busy} onClick={queue("settle")}>
                  <RiCheckboxCircleLine aria-hidden />
                  {m.sidebar_thread_settle()}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" disabled={busy} onClick={queue("delete")}>
                <RiDeleteBinLine aria-hidden />
                {m.sidebar_thread_delete()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <SettleDialog thread={thread} open={mode === "settle"} onOpenChange={closeDialog} />
      <DeleteThreadDialog thread={thread} open={mode === "delete"} onOpenChange={closeDialog} />
    </li>
  )
}

/** Rename starts from an explicit menu choice, so the field takes focus as soon as it appears. */
const focusOnMount = (input: HTMLInputElement | null) => input?.focus()

function RenameInput({ thread, onDone }: { thread: Thread; onDone: () => void }) {
  const [draft, setDraft] = useState(thread.title)
  const [error, setError] = useState<string | null>(null)
  const errorId = `rename-error-${thread.id}`

  const commit = async () => {
    const title = draft.trim()
    if (title === "" || title === thread.title) return onDone()
    try {
      useThreads.getState().upsert(await callPromise("threads.update", { id: thread.id, title }))
      onDone()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      void commit()
    }
    if (event.key === "Escape") {
      event.preventDefault()
      onDone()
    }
  }

  return (
    <div className="flex flex-col gap-1 py-0.5">
      <Input
        ref={focusOnMount}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
        aria-label={m.sidebar_thread_rename_label({ title: thread.title })}
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        className="h-7 text-sm"
      />
      {error && (
        <p id={errorId} role="alert" className="px-1 text-xs text-destructive">
          {m.sidebar_rename_failed({ message: error })}
        </p>
      )}
    </div>
  )
}

interface DeleteThreadDialogProps {
  readonly thread: Thread
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

function DeleteThreadDialog({ thread, open, onOpenChange }: DeleteThreadDialogProps) {
  const worktree = useActiveWorktree(thread)
  const navigate = useNavigate()
  const { threadId: openThreadId } = useParams({ strict: false })

  const [error, remove, isPending] = useActionState(async () => {
    try {
      await callPromise("threads.delete", { id: thread.id })
    } catch (cause) {
      return errorMessage(cause)
    }
    onOpenChange(false)
    if (openThreadId === thread.id) await navigate({ to: "/" })
    useThreads.getState().remove(thread.id)
    return null
  }, null)

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.delete_dialog_title()}</AlertDialogTitle>
          <AlertDialogDescription>{m.delete_dialog_body({ title: thread.title })}</AlertDialogDescription>
          {worktree && (
            <AlertDialogDescription>{m.delete_dialog_worktree({ path: worktree.path })}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={isPending} onClick={() => startTransition(remove)}>
            {m.delete_dialog_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const statusDot: Partial<Record<ThreadStatus, { label: () => string; className: string }>> = {
  running: { label: m.thread_status_running, className: "bg-emerald-500 animate-pulse motion-reduce:animate-none" },
  awaiting_approval: { label: m.thread_status_awaiting_approval, className: "bg-amber-500" },
}

/** A dot for threads that need watching: pulsing while running, steady while waiting for approval. */
function StatusDot({ status }: { status: ThreadStatus }): ReactNode {
  const dot = statusDot[status]
  if (!dot) return null
  return (
    <span title={dot.label()} className="flex shrink-0 items-center">
      <span aria-hidden className={`size-2 rounded-full ${dot.className}`} />
      <span className="sr-only">{dot.label()}</span>
    </span>
  )
}

function WorktreeBranch({ worktreeId }: { worktreeId: string }) {
  const worktree = useWorktrees((state) => state.byId[worktreeId])
  if (!worktree) return null
  return (
    <span
      className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground data-[removed=true]:line-through"
      data-removed={worktree.status === "removed"}
      title={m.sidebar_worktree_branch({ branch: worktree.branch })}
    >
      <RiGitBranchLine aria-hidden className="size-3 shrink-0" />
      <span className="truncate font-mono">{worktree.branch}</span>
    </span>
  )
}
