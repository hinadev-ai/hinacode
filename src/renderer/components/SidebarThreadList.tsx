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
import { useAtomValue } from "@effect/atom-react"
import { Link, useRouter } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useActionState,
  useId,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import {
  RiAlarmLine,
  RiAlarmSnoozeLine,
  RiArchiveLine,
  RiDeleteBinLine,
  RiDraggable,
  RiEyeLine,
  RiEyeOffLine,
  RiFileCopyLine,
  RiInboxUnarchiveLine,
  RiMoreFill,
  RiPencilLine,
  RiPushpinLine,
  RiUnpinLine,
} from "react-icons/ri"
import type { IconType } from "react-icons"
import { toast } from "sonner"
import { isThreadBusy, type PullRequestLink, type Thread } from "../../shared/domain.ts"
import { type RowState, rowEmphasis, rowState, rowStatusIndicator } from "../../shared/threadStatus.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { toIcon } from "../lib/indicators.ts"
import { formatRelativeTime } from "../lib/relativeTime.ts"
import { formatSnoozeTime } from "../lib/snooze.ts"
import { callPromise, type EnvironmentId, projectsAtom, pullRequestAttentionAtom } from "../lib/rpc.ts"
import { type Cloud, isStale, useCloud, useThreadEnvironment } from "../lib/environments.ts"
import { useSettings } from "../lib/settings.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useBackgroundTasks } from "../stores/backgroundTasks.ts"
import { useDrafts } from "../stores/drafts.ts"
import { usePullRequests } from "../stores/pullRequests.ts"
import { lastActivity, useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { useUnseen } from "../stores/unseen.ts"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { SidebarPullRequests } from "./SidebarPullRequests.tsx"
import { ArchiveDialog, useActiveWorktree } from "./ArchiveDialog.tsx"
import { CloudMark } from "./CloudMark.tsx"
import { Button } from "./ui/button.tsx"
import { Checkbox } from "./ui/checkbox.tsx"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx"
import { Field, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover.tsx"
import { ProjectIcon } from "./ProjectIcon.tsx"
import { snoozeThread } from "./SnoozeDialog.tsx"

type DragDropPlugins = NonNullable<ComponentProps<typeof DragDropProvider>["plugins"]>

const titleOf = (id: unknown) => useThreads.getState().byId[String(id)]?.title ?? ""

const position = (source: Draggable) => ({
  position: String((isSortable(source) ? source.index : 0) + 1),
  total: String([...(source.manager?.registry.draggables ?? [])].length),
})

const accessibility = () =>
  Accessibility.configure({
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

const plugins: DragDropPlugins = (defaults) => [
  ...defaults.filter((plugin) => plugin !== Accessibility),
  accessibility(),
]

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
      event.target.closest("button, input, a[target]") !== null,
  }),
  KeyboardSensor,
]

interface SidebarThreadListProps {
  readonly group: string
  readonly threads: ReadonlyArray<Thread>
  readonly reorderable: boolean
  readonly showProject?: boolean
  readonly showEmptyHint?: boolean
  readonly newThreadButtonRef?: RefObject<HTMLButtonElement | null>
  readonly className?: string
}

export function SidebarThreadList({
  group,
  threads,
  reorderable,
  showProject = false,
  showEmptyHint = false,
  newThreadButtonRef,
  className = "",
}: SidebarThreadListProps) {
  const firstRowRef = useRef<HTMLAnchorElement>(null)
  const focusAfterRemoval = () => firstRowRef.current ?? newThreadButtonRef?.current ?? null
  const [listRef, setAnimate] = useAutoAnimate<HTMLUListElement>({ duration: 150 })
  const DROP_ANIMATION_MS = 300
  const [reorderError, setReorderError] = useState<string | null>(null)

  const save = async (ordered: ReadonlyArray<Thread>) => {
    const moved = ordered.flatMap((thread, index) =>
      thread.sortIndex === index ? [] : [{ ...thread, sortIndex: index }],
    )
    const { upsert } = useThreads.getState()
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
          if (!event.canceled) void save(move([...threads], event))
          // FIXME: dnd-kit still plays its drop animation here, and auto-animate on top slides the row twice
          setTimeout(() => setAnimate(true), DROP_ANIMATION_MS)
        }}
      >
        <ul ref={listRef} className={`flex flex-col gap-0.5 py-0.5 ${className}`}>
          {threads.length === 0 && showEmptyHint && (
            <li className="px-1.5 py-1 text-xs text-muted-foreground">{m.sidebar_no_threads()}</li>
          )}
          {threads.map((thread, index) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              index={index}
              group={group}
              reorderable={reorderable}
              showProject={showProject}
              linkRef={index === 0 ? firstRowRef : undefined}
              focusAfterRemoval={focusAfterRemoval}
            />
          ))}
        </ul>
      </DragDropProvider>
      {reorderError && (
        <p role="alert" className="px-1.5 py-1 text-xs text-destructive">
          {m.sidebar_reorder_failed({ message: reorderError })}
        </p>
      )}
    </>
  )
}

type RowMode = "idle" | "renaming" | "archive" | "delete"

interface ThreadRowProps {
  readonly thread: Thread
  readonly index: number
  readonly group: string
  readonly reorderable: boolean
  readonly showProject: boolean
  readonly linkRef: RefObject<HTMLAnchorElement | null> | undefined
  readonly focusAfterRemoval: () => HTMLElement | null
}

function ThreadRow({ thread, index, group, reorderable, showProject, linkRef, focusAfterRemoval }: ThreadRowProps) {
  const { ref, handleRef, isDragSource } = useSortable({ id: thread.id, index, group, disabled: !reorderable })
  const [menuOpen, setMenuOpen] = useState(false)
  const [mode, setMode] = useState<RowMode>("idle")
  const [queued, setQueued] = useState<RowMode | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const worktree = useActiveWorktree(thread)
  const environment = useThreadEnvironment(thread.id)
  const cloud = useCloud(environment)
  const { archive: archiveSettings } = useSettings(environment)
  const busy = isThreadBusy(thread.status)
  const archived = thread.status === "archived"
  const archiveDeletes = archiveSettings.removeWorktree && worktree !== undefined
  const meta = useThreadMeta(thread, showProject)
  const hasMeta = cloud !== undefined || meta.links.length > 0
  const state = useThreadRowState(thread)

  const moveOut = (updated: Thread) => {
    flushSync(() => useThreads.getState().upsert(updated))
    if (document.activeElement === document.body) focusAfterRemoval()?.focus({ preventScroll: true })
  }
  const archive = async () => {
    try {
      moveOut(await callPromise("threads.archive", { threadId: thread.id }))
    } catch (cause) {
      toast.error(m.sidebar_archive_failed({ message: errorMessage(cause) }))
    }
  }
  const unarchive = async () => {
    try {
      moveOut(await callPromise("threads.unarchive", { threadId: thread.id }))
    } catch (cause) {
      toast.error(m.sidebar_unarchive_failed({ message: errorMessage(cause) }))
    }
  }
  const pinned = thread.pinnedAt !== null
  const togglePin = async () => {
    try {
      moveOut(await callPromise("threads.update", { id: thread.id, pinned: !pinned }))
    } catch (cause) {
      toast.error((pinned ? m.sidebar_unpin_failed : m.sidebar_pin_failed)({ message: errorMessage(cause) }))
    }
  }
  const watched = meta.links.filter((link) => link.watch !== null)
  const unwatch = async (url: string) => {
    try {
      await callPromise("pullRequests.unwatch", { threadId: thread.id, url })
    } catch (cause) {
      toast.error(m.pr_watch_failed({ message: errorMessage(cause) }))
    }
  }

  const queue = (next: RowMode) => () => setQueued(next)
  const closeDialog = (open: boolean) => {
    if (!open) setMode("idle")
  }
  const finishRename = () => {
    flushSync(() => setMode("idle"))
    menuTriggerRef.current?.focus()
  }

  return (
    <li
      // FIXME: dnd-kit marks a handleless row as a button, which reads as disabled without a handle
      ref={reorderable ? ref : undefined}
      data-dragging={isDragSource}
      data-menu-open={menuOpen}
      data-emphasis={rowEmphasis[state]}
      data-archived={archived}
      data-stale={isStale(cloud)}
      data-show-project={meta.project !== null}
      data-meta={hasMeta}
      onPointerEnter={(event) => scrollTitle(event.currentTarget)}
      onPointerLeave={(event) => stopTitle(event.currentTarget)}
      className="group/thread relative rounded-md [--row-actions:--spacing(20)] has-[[data-reorder-handle]:focus-visible]:[--row-actions:--spacing(26)] text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground has-[a[data-status=active]]:bg-sidebar-accent has-[a[data-status=active]]:text-sidebar-accent-foreground data-[dragging=true]:bg-sidebar-accent data-[dragging=true]:opacity-80 data-[emphasis=working]:text-muted-foreground data-[emphasis=working]:not-hover:not-focus-within:not-has-[a[data-status=active]]:opacity-60 data-[stale=true]:data-[emphasis=resting]:text-muted-foreground"
    >
      {meta.project !== null && (
        <div className="flex min-w-0 items-center gap-1 pt-1.5 pr-2 pl-1.5 text-xs text-muted-foreground">
          <ProjectIcon projectId={thread.projectId} className="size-3 text-current" />
          <span className="truncate" title={meta.project}>
            {meta.project}
          </span>
        </div>
      )}
      {mode === "renaming" ? (
        <RenameInput thread={thread} onDone={finishRename} />
      ) : (
        <Link
          ref={linkRef}
          to="/thread/$threadId"
          params={{ threadId: thread.id }}
          draggable={false}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenuOpen(true)
          }}
          data-reorderable={reorderable}
          className="flex items-center gap-2 rounded-md pt-1.5 pr-2 group-data-[show-project=true]/thread:pt-0.5 pb-0.5 group-data-[meta=false]/thread:pb-1.5 pl-1.5 outline-none after:absolute after:inset-0 after:rounded-md group-hover/thread:pr-(--row-actions) group-has-[a:focus-visible,button:focus]/thread:pr-(--row-actions) group-data-[menu-open=true]/thread:pr-(--row-actions) focus-visible:after:ring-2 focus-visible:after:ring-sidebar-ring data-[reorderable=true]:cursor-grab"
        >
          <span
            dir="auto"
            className="min-w-0 flex-1 truncate text-left text-[0.9375rem] group-hover/thread:text-clip"
            title={thread.title}
          >
            <span data-title-text className="group-hover/thread:inline-block">
              {thread.title}
            </span>
          </span>
          <StatusIndicator state={state} />
          <span aria-hidden className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground group-hover/thread:hidden group-has-[a:focus-visible,button:focus]/thread:hidden group-data-[menu-open=true]/thread:hidden">
            <ActivityTime {...meta} />
            <ProviderIcon provider={meta.provider} className="size-3" />
          </span>
        </Link>
      )}
      {hasMeta && <ThreadMeta links={meta.links} threadId={thread.id} cloud={cloud} environment={environment} />}

      {mode !== "renaming" && (
        <div className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 group-hover/thread:opacity-100 group-has-[a:focus-visible]/thread:opacity-100 focus-within:opacity-100 group-data-[menu-open=true]/thread:opacity-100 has-[[data-popup-open]]:opacity-100">
          {archived ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={m.sidebar_thread_unarchive_label({ title: thread.title })}
              title={m.sidebar_thread_unarchive()}
              onClick={() => void unarchive()}
            >
              <RiInboxUnarchiveLine aria-hidden />
            </Button>
          ) : (
            <>
              {reorderable && (
                <Button
                  ref={handleRef}
                  variant="ghost"
                  size="icon-xs"
                  aria-label={m.sidebar_thread_reorder({ title: thread.title })}
                  aria-roledescription={m.sidebar_thread_reorder_role()}
                  data-reorder-handle
                  className="sr-only cursor-grab focus-visible:not-sr-only"
                >
                  <RiDraggable aria-hidden />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={m.sidebar_thread_archive_label({ title: thread.title })}
                title={m.sidebar_thread_archive()}
                disabled={busy}
                onClick={archiveDeletes ? () => setMode("archive") : () => void archive()}
              >
                <RiArchiveLine aria-hidden />
              </Button>
            </>
          )}
          <DeleteThreadPopover
            thread={thread}
            cloud={cloud}
            disabled={busy || isStale(cloud)}
            open={mode === "delete"}
            onOpenChange={(open) => setMode(open ? "delete" : "idle")}
            focusAfterDelete={focusAfterRemoval}
          />
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
              {!archived && (
                <DropdownMenuItem onClick={() => void togglePin()}>
                  {pinned ? <RiUnpinLine aria-hidden /> : <RiPushpinLine aria-hidden />}
                  {pinned ? m.sidebar_thread_unpin() : m.sidebar_thread_pin()}
                </DropdownMenuItem>
              )}
              {!archived && (
                <DropdownMenuItem onClick={() => useUi.getState().setSnoozeThreadId(thread.id)}>
                  <RiAlarmSnoozeLine aria-hidden />
                  {m.sidebar_thread_snooze()}
                </DropdownMenuItem>
              )}
              {!archived && meta.snoozedUntil !== null && (
                <DropdownMenuItem onClick={() => void snoozeThread(thread, null)}>
                  <RiAlarmLine aria-hidden />
                  {m.sidebar_thread_unsnooze()}
                </DropdownMenuItem>
              )}
              {watched.length === 0 ? (
                <DropdownMenuItem disabled>
                  <RiEyeOffLine aria-hidden />
                  {m.sidebar_thread_unwatch()}
                </DropdownMenuItem>
              ) : (
                watched.map((link) => (
                  <DropdownMenuItem key={link.id} onClick={() => void unwatch(link.url)}>
                    <RiEyeOffLine aria-hidden />
                    {watched.length > 1
                      ? m.pr_watch_stop({ name: `#${pullRequestNumber(link.url)}` })
                      : m.sidebar_thread_unwatch()}
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(thread.id)}>
                <RiFileCopyLine aria-hidden />
                {m.sidebar_thread_copy_id()}
              </DropdownMenuItem>
              {archived ? (
                <DropdownMenuItem onClick={() => void unarchive()}>
                  <RiInboxUnarchiveLine aria-hidden />
                  {m.sidebar_thread_unarchive()}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled={busy} onClick={archiveDeletes ? queue("archive") : () => void archive()}>
                  <RiArchiveLine aria-hidden />
                  {archiveDeletes ? m.sidebar_thread_archive_confirm() : m.sidebar_thread_archive()}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" disabled={busy || isStale(cloud)} onClick={queue("delete")}>
                <RiDeleteBinLine aria-hidden />
                {m.sidebar_thread_delete()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {worktree && (
        <ArchiveDialog
          thread={thread}
          worktree={worktree}
          open={mode === "archive"}
          onOpenChange={closeDialog}
          onArchived={moveOut}
        />
      )}
    </li>
  )
}

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
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 pt-1.5 pr-2 pb-0.5 pl-1.5 group-data-[show-project=true]/thread:pt-0.5">
        <span className="flex min-w-0 flex-1 flex-col">
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
            className="-ml-1.5 h-5.5 rounded-sm px-1.5 py-0 text-[0.9375rem]"
          />
        </span>
      </div>
      {error && (
        <p id={errorId} role="alert" className="px-1 text-xs text-destructive">
          {m.sidebar_rename_failed({ message: error })}
        </p>
      )}
    </div>
  )
}

interface DeleteThreadPopoverProps {
  readonly thread: Thread
  readonly cloud: Cloud | undefined
  readonly disabled: boolean
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly focusAfterDelete: () => HTMLElement | null
}

function DeleteThreadPopover({
  thread,
  cloud,
  disabled,
  open,
  onOpenChange,
  focusAfterDelete,
}: DeleteThreadPopoverProps) {
  const worktree = useActiveWorktree(thread)
  const router = useRouter()
  const [removeWorktree, setRemoveWorktree] = useState(true)
  const removeWorktreeId = useId()
  const offline = isStale(cloud)

  const [error, remove, isPending] = useActionState(async () => {
    const failure = await callPromise("threads.delete", {
      id: thread.id,
      removeWorktree: worktree !== undefined && removeWorktree,
    }).then(() => null, errorMessage)
    if (failure !== null) return failure
    if (router.matchRoute({ to: "/thread/$threadId", params: { threadId: thread.id } }) !== false) {
      await router.navigate({ to: "/" })
    }
    useThreads.getState().remove(thread.id)
    useDrafts.getState().discard(thread.id)
    return null
  }, null)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={m.sidebar_thread_delete_label({ title: thread.title })}
            title={m.sidebar_thread_delete()}
          />
        }
      >
        <RiDeleteBinLine aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        className="w-64"
        finalFocus={() => (useThreads.getState().byId[thread.id] ? true : focusAfterDelete())}
      >
        <PopoverHeader>
          <PopoverTitle>{m.delete_dialog_title()}</PopoverTitle>
          <PopoverDescription>{m.delete_dialog_body({ title: thread.title })}</PopoverDescription>
          {worktree && (
            <PopoverDescription className="break-all">
              {m.delete_dialog_worktree({ path: worktree.path })}
            </PopoverDescription>
          )}
        </PopoverHeader>
        {worktree && (
          <Field orientation="horizontal">
            <Checkbox id={removeWorktreeId} checked={removeWorktree} onCheckedChange={setRemoveWorktree} />
            <FieldLabel htmlFor={removeWorktreeId}>{m.delete_dialog_remove_worktree()}</FieldLabel>
          </Field>
        )}
        {offline && cloud && <p className="text-muted-foreground">{m.delete_dialog_offline({ name: cloud.name })}</p>}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="destructive" size="sm" disabled={isPending || offline} action={remove}>
            {m.delete_dialog_confirm()}
          </Button>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {m.common_cancel()}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

const awaiting = toIcon(rowStatusIndicator.awaiting_approval)

const statusIcons: Partial<Record<RowState, { label: () => string; Icon: IconType; className: string }>> = {
  running: { label: m.thread_status_running, ...toIcon(rowStatusIndicator.running) },
  background: { label: m.thread_status_background, ...toIcon(rowStatusIndicator.background) },
  awaiting_approval: {
    label: m.thread_status_awaiting_approval,
    Icon: awaiting.Icon,
    className: `${awaiting.className} after:absolute after:inset-0.5 after:animate-attention after:rounded-full after:border after:border-current after:[animation-fill-mode:forwards] motion-reduce:after:hidden`,
  },
  limited: { label: m.thread_status_limited, ...toIcon(rowStatusIndicator.limited) },
  unseen_completed: { label: m.thread_status_unseen_completed, ...toIcon(rowStatusIndicator.unseen_completed) },
  unseen_failed: { label: m.thread_status_unseen_failed, ...toIcon(rowStatusIndicator.unseen_failed) },
  pr_conflicting: { label: m.thread_status_pr_conflicting, ...toIcon(rowStatusIndicator.pr_conflicting) },
  pr_checksFailing: { label: m.thread_status_pr_checks_failing, ...toIcon(rowStatusIndicator.pr_checksFailing) },
  pr_changesRequested: {
    label: m.thread_status_pr_changes_requested,
    ...toIcon(rowStatusIndicator.pr_changesRequested),
  },
}

export function useThreadRowState(thread: Thread): RowState {
  const environment = useThreadEnvironment(thread.id)
  const links = usePullRequests((state) => state.byThreadId[thread.id]) ?? noLinks
  return rowState(
    thread.status,
    useBackgroundTasks((state) => (state.byThreadId[thread.id]?.length ?? 0) > 0),
    useUnseen((unseen) => unseen.byThreadId[thread.id]),
    useAtomValue(
      pullRequestAttentionAtom(
        environment,
        links.map((link) => link.url),
      ),
    ),
  )
}

export function StatusIndicator({ state }: { state: RowState }): ReactNode {
  const status = statusIcons[state]
  if (!status) return null
  const { label, Icon, className } = status
  return (
    <span title={label()} className={`relative flex shrink-0 items-center ${className}`}>
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{label()}</span>
    </span>
  )
}

function useThreadMeta(thread: Thread, showProject: boolean) {
  const links = usePullRequests((state) => state.byThreadId[thread.id]) ?? noLinks
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  return {
    project: showProject ? (projects.find((project) => project.id === thread.projectId)?.name ?? null) : null,
    links,
    threadId: thread.id,
    provider: thread.provider,
    updatedAt: lastActivity(thread),
    snoozedUntil: useSnoozedUntil(thread),
  }
}

function useSnoozedUntil(thread: Thread) {
  const now = useNow()
  return thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now ? thread.snoozedUntil : null
}

const noLinks: ReadonlyArray<PullRequestLink> = []
const pullRequestNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1] ?? ""

function ThreadMeta({
  links,
  threadId,
  cloud,
  environment,
}: {
  links: ReadonlyArray<PullRequestLink>
  threadId: string
  cloud: Cloud | undefined
  environment: EnvironmentId
}) {
  const watching = links.some((link) => link.watch !== null)
  return (
    <div className="flex min-w-0 items-center gap-2 pr-2 pb-1.5 pl-1.5 text-xs text-muted-foreground group-hover/thread:pr-(--row-actions) group-has-[a:focus-visible,button:focus]/thread:pr-(--row-actions) group-data-[menu-open=true]/thread:pr-(--row-actions)">
      {cloud && <CloudMark cloud={cloud} className="size-3" />}
      {links.length > 0 && <SidebarPullRequests threadId={threadId} links={links} environment={environment} />}
      {watching && (
        <span title={m.sidebar_watching()} className="flex shrink-0">
          <RiEyeLine aria-hidden className="size-3" />
          <span className="sr-only">{m.sidebar_watching()}</span>
        </span>
      )}
    </div>
  )
}

const TITLE_SCROLL_DELAY_MS = 400
const TITLE_SCROLL_PX_PER_S = 60

const titleText = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-title-text]")

function scrollTitle(row: HTMLElement) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
  requestAnimationFrame(() => {
    const text = titleText(row)
    const box = text?.parentElement
    if (!text || !box || !row.matches(":hover")) return
    const overflow = text.offsetWidth - box.clientWidth
    if (overflow <= 0) return
    const distance = getComputedStyle(box).direction === "rtl" ? overflow : -overflow
    text.animate([{ transform: "translateX(0)" }, { transform: `translateX(${distance}px)` }], {
      duration: (overflow / TITLE_SCROLL_PX_PER_S) * 1000,
      delay: TITLE_SCROLL_DELAY_MS,
      easing: "linear",
      fill: "forwards",
    })
  })
}

function stopTitle(row: HTMLElement) {
  for (const animation of titleText(row)?.getAnimations() ?? []) animation.cancel()
}

function ActivityTime({ updatedAt, snoozedUntil }: { updatedAt: string; snoozedUntil: string | null }) {
  return snoozedUntil === null ? <LastActive updatedAt={updatedAt} /> : <WakeTime snoozedUntil={snoozedUntil} />
}

function LastActive({ updatedAt }: { updatedAt: string }) {
  const now = useNow()
  const locale = getLocale()
  return (
    <time
      dateTime={updatedAt}
      title={new Date(updatedAt).toLocaleString(locale, { dateStyle: "long", timeStyle: "short" })}
      className="tabular-nums"
    >
      {formatRelativeTime(updatedAt, now, locale)}
    </time>
  )
}

function WakeTime({ snoozedUntil }: { snoozedUntil: string }) {
  const now = useNow()
  const locale = getLocale()
  const time = formatSnoozeTime(new Date(snoozedUntil), new Date(now), locale)
  return (
    <time
      dateTime={snoozedUntil}
      title={m.sidebar_snoozed_until({ time })}
      className="flex items-center gap-1 tabular-nums"
    >
      <RiAlarmSnoozeLine aria-hidden className="size-3" />
      <span className="sr-only">{m.sidebar_snoozed_until({ time })}</span>
      <span aria-hidden>{time}</span>
    </time>
  )
}
