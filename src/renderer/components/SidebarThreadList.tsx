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
import { useAtomValue } from "@effect/atom-react"
import { Link, useRouter } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  memo,
  startTransition,
  useActionState,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import { RiGitMergeLine } from "react-icons/ri"
import { toast } from "sonner"
import type { ProviderId } from "../../shared/agent.ts"
import { isThreadBusy, type PullRequestLink, type Thread, type Worktree } from "../../shared/domain.ts"
import { type RowState, rowEmphasis, rowState, rowStatusIndicator } from "../../shared/threadStatus.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { toIcon } from "../lib/indicators.ts"
import { formatElapsed } from "../lib/relativeTime.ts"
import { formatSnoozeTime } from "../lib/snooze.ts"
import { nestChildren } from "../lib/threadTree.ts"
import { pullRequestDetail, type RowDetail, rowDetail } from "../lib/rowDetail.ts"
import {
  callPromise,
  currentBranchAtom,
  type EnvironmentId,
  projectsAtom,
  pullRequestAttentionAtom,
} from "../lib/rpc.ts"
import { type Cloud, isStale, useCloud, useThreadEnvironment } from "../lib/environments.ts"
import { useSettings } from "../lib/settings.ts"
import { cn } from "../lib/utils.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useBackgroundTasks } from "../stores/backgroundTasks.ts"
import { useActivity } from "../stores/activity.ts"
import { hasContent, useDrafts } from "../stores/drafts.ts"
import { usePullRequests } from "../stores/pullRequests.ts"
import { lastActivity, useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { SidebarRow, SidebarRowPresence } from "./SidebarRowMotion.tsx"
import { useUnseen } from "../stores/unseen.ts"
import { ProjectIcon } from "./ProjectIcon.tsx"
import { ThreadProviderIcon } from "./ProviderIcon.tsx"
import { SidebarPullRequests } from "./SidebarPullRequests.tsx"
import { ArchiveDialog, useActiveWorktree } from "./ArchiveDialog.tsx"
import { CloudMark } from "./CloudMark.tsx"
import { Button } from "./ui/button.tsx"
import { Checkbox } from "./ui/checkbox.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"
import { Field, FieldLabel } from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle } from "./ui/popover.tsx"
import { snoozeThread } from "./SnoozeDialog.tsx"
import {
  AlarmIcon,
  ArchiveIcon,
  CheckIcon,
  CopyIcon,
  ForkIcon,
  EyeIcon,
  EyeOffIcon,
  GripIcon,
  type IconComponent,
  MoreIcon,
  BranchIcon,
  CloseIcon,
  PencilIcon,
  PinIcon,
  RefreshIcon,
  SnoozeIcon,
  TrashIcon,
  UnarchiveIcon,
  UnpinIcon,
  CheckCircleIcon,
  FeedbackIcon,
  HourglassIcon,
  QuestionIcon,
  WarningIcon,
  XCircleIcon,
} from "@hinacode/icons"

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
  readonly pageSize?: number
}

export function SidebarThreadList({
  group,
  threads,
  reorderable,
  showProject = false,
  showEmptyHint = false,
  newThreadButtonRef,
  className = "",
  pageSize = Number.POSITIVE_INFINITY,
}: SidebarThreadListProps) {
  const firstRowRef = useRef<HTMLAnchorElement>(null)
  const focusAfterRemoval = () => firstRowRef.current ?? newThreadButtonRef?.current ?? null
  const filtering = useUi((state) => state.sidebarQuery !== "")
  const [dragging, setDragging] = useState(false)
  const DROP_ANIMATION_MS = 300
  const [reorderError, setReorderError] = useState<string | null>(null)
  const entries = nestChildren(threads)
  const [shownCount, setShownCount] = useState(pageSize)
  const shownEntries = entries.slice(0, shownCount)

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
        onDragStart={() => setDragging(true)}
        onDragEnd={(event) => {
          if (!event.canceled)
            void save(
              move(
                entries.map((entry) => entry.thread),
                event,
              ),
            )
          // FIXME: dnd-kit still plays its drop animation here, and a layout glide on top slides the row twice
          setTimeout(() => setDragging(false), DROP_ANIMATION_MS)
        }}
      >
        <ul className={`flex flex-col gap-1 ${className}`}>
          {threads.length === 0 && showEmptyHint && (
            <li className="px-1.5 py-1 text-xs text-muted-foreground">{m.sidebar_no_threads()}</li>
          )}
          <SidebarRowPresence placements={placementsOf("", shownEntries)} still={filtering || dragging}>
            {shownEntries.map(({ thread, nested }, index) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                nested={nested}
                index={index}
                group={group}
                reorderable={reorderable && !nested}
                showProject={showProject}
                showActivity={false}
                linkRef={index === 0 ? firstRowRef : undefined}
                focusAfterRemoval={focusAfterRemoval}
              />
            ))}
          </SidebarRowPresence>
        </ul>
      </DragDropProvider>
      {shownCount < entries.length && (
        <NextPageSentinel
          key={shownCount}
          onReached={() => startTransition(() => setShownCount((count) => count + pageSize))}
        />
      )}
      {reorderError && (
        <p role="alert" className="px-1.5 py-1 text-xs text-destructive">
          {m.sidebar_reorder_failed({ message: reorderError })}
        </p>
      )}
    </>
  )
}

const NEXT_PAGE_MARGIN = "400px"

function NextPageSentinel({ onReached }: { readonly onReached: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const handleReached = useEffectEvent(onReached)
  useEffect(() => {
    if (!ref.current) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) handleReached()
      },
      { rootMargin: NEXT_PAGE_MARGIN, scrollMargin: NEXT_PAGE_MARGIN },
    )
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return <div ref={ref} aria-hidden className="h-px" />
}

export interface TurnSection {
  readonly key: string
  readonly group: string
  readonly heading: ReactNode
  readonly headingClassName?: string
  readonly threads: ReadonlyArray<Thread>
  readonly flat?: boolean
  readonly showActivity?: boolean
  readonly empty?: ReactNode
  readonly spaced?: boolean
  readonly drafts?: ReadonlyArray<{ readonly thread: Thread; readonly title: string }>
  readonly projectNames?: ReadonlyMap<string, string>
}

export function TurnList({ sections, className }: { sections: ReadonlyArray<TurnSection>; className: string }) {
  const firstRowRef = useRef<HTMLAnchorElement>(null)
  const filtering = useUi((state) => state.sidebarQuery !== "")
  const entriesOf = (section: TurnSection) =>
    section.flat ? section.threads.map((thread) => ({ thread, nested: false })) : nestChildren(section.threads)
  const firstThread = sections.flatMap((section) => entriesOf(section))[0]?.thread
  const focusFirstRow = () => firstRowRef.current
  return (
    <DragDropProvider>
      <ul className={`flex flex-col gap-1 ${className}`}>
        <SidebarRowPresence
          placements={sections.flatMap((section) => placementsOf(section.key, entriesOf(section)))}
          still={filtering}
        >
          {sections.flatMap((section) => [
            ...(section.spaced
              ? [
                  <SidebarRow key={`space-${section.key}`} aria-hidden>
                    <div className="h-3" />
                  </SidebarRow>,
                ]
              : []),
            <SidebarRow key={`heading-${section.key}`} className={cn("-mx-2", section.headingClassName)}>
              {section.heading}
            </SidebarRow>,
            ...(section.threads.length === 0 && section.empty !== undefined
              ? [
                  <SidebarRow key={`empty-${section.key}`} className="px-2.5 pb-1 text-xs text-sidebar-meta">
                    {section.empty}
                  </SidebarRow>,
                ]
              : []),
            ...(section.drafts ?? []).map(({ thread, title }) => (
              <DraftRow
                key={`draft-${thread.id}`}
                thread={thread}
                title={title}
                project={section.projectNames?.get(thread.projectId) ?? null}
              />
            )),
            ...entriesOf(section).map(({ thread, nested }, index) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                nested={nested}
                index={index}
                group={section.group}
                reorderable={false}
                showProject
                showActivity={section.showActivity ?? false}
                linkRef={thread === firstThread ? firstRowRef : undefined}
                focusAfterRemoval={focusFirstRow}
              />
            )),
          ])}
        </SidebarRowPresence>
      </ul>
    </DragDropProvider>
  )
}

const placementsOf = (section: string, entries: ReadonlyArray<{ readonly thread: Thread }>) =>
  entries.map((entry) => ({ id: entry.thread.id, section }))

export const READY_GROUP = "ready"
export const SETTLED_GROUP = "settled"
export const ARCHIVED_GROUP = "archived"

const rowClassName =
  "group/thread relative rounded-lg text-sidebar-title transition-colors duration-100 hover:bg-sidebar-row-hover hover:text-sidebar-foreground hover:[--sidebar-meta:var(--sidebar-meta-raised)] has-[a[data-status=active]]:bg-sidebar-row-selected has-[a[data-status=active]]:text-sidebar-foreground has-[a[data-status=active]]:[--sidebar-meta:var(--sidebar-meta-raised)] data-[dimmed=true]:not-hover:not-has-[a[data-status=active]]:text-sidebar-title-read data-[dragging=true]:bg-sidebar-row-selected data-[dragging=true]:opacity-80 data-[emphasis=working]:not-hover:not-has-[a[data-status=active]]:text-sidebar-meta data-[emphasis=working]:not-has-[a[data-status=active]]:not-hover:not-focus-within:opacity-60 data-[nested=true]:ms-3.5 data-[stale=true]:data-[emphasis=resting]:text-sidebar-meta motion-reduce:transition-none"
const rowLinkClassName =
  "flex items-center gap-2 rounded-lg px-2.5 pt-1.75 pb-1.5 outline-none [grid-area:1/1] group-data-[show-project=true]/thread:pt-1 after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-sidebar-ring data-[reorderable=true]:cursor-grab"
const rowActionsClassName =
  "relative mr-1.5 flex items-center gap-0.5 self-center justify-self-end rounded-md bg-sidebar-row-hover opacity-0 [grid-area:1/1] group-hover/thread:opacity-100 group-has-[a:focus-visible]/thread:opacity-100 group-has-[a[data-status=active]]/thread:bg-sidebar-row-selected group-data-[menu-open=true]/thread:opacity-100 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-4 before:bg-linear-to-l before:from-sidebar-row-hover group-has-[a[data-status=active]]/thread:before:from-sidebar-row-selected focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 [@media(hover:none)]:pointer-events-none"

interface DraftRowsProps {
  readonly drafts: ReadonlyArray<{ readonly thread: Thread; readonly title: string }>
  readonly className: string
}

export function DraftRows({ drafts, className }: DraftRowsProps) {
  return (
    <ul className={`flex flex-col gap-1 ${className}`}>
      {drafts.map(({ thread, title }) => (
        <DraftRow key={thread.id} thread={thread} title={title} project={null} />
      ))}
    </ul>
  )
}

function ProjectLine({ project, projectId, trailing }: { project: string; projectId: string; trailing: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2.5 pt-1.5 text-xs text-sidebar-meta">
      <ProjectIcon projectId={projectId} letterOf={project} className="size-3.5" />
      <span className="min-w-0 truncate" title={project}>
        {project}
      </span>
      <span className="ms-auto shrink-0 ps-2">{trailing}</span>
    </div>
  )
}

function DraftRow({ thread, title, project }: { thread: Thread; title: string; project: string | null }) {
  const discard = () => {
    const discarded = useDrafts.getState().take(thread.id)
    toast(m.sidebar_unsent_discarded(), {
      action: { label: m.common_undo(), onClick: () => useDrafts.getState().restore(thread.id, discarded) },
    })
  }

  return (
    <SidebarRow data-emphasis="resting" data-meta={false} data-show-project={project !== null} className={rowClassName}>
      {project !== null && (
        <ProjectLine
          project={project}
          projectId={thread.projectId}
          trailing={<ThreadProviderIcon provider={thread.provider} model={thread.model} className="size-3" />}
        />
      )}
      <div className="grid grid-cols-1">
        <Link
          to="/thread/$threadId"
          params={{ threadId: thread.id }}
          draggable={false}
          aria-description={m.sidebar_thread_draft()}
          className={rowLinkClassName}
        >
          <span dir="auto" className="min-w-0 flex-1 truncate text-left text-sm" title={title}>
            {title}
          </span>
          {project === null && (
            <span aria-hidden className="flex shrink-0 items-center gap-2 text-xs text-sidebar-meta">
              {m.sidebar_thread_draft()}
              <ThreadProviderIcon provider={thread.provider} model={thread.model} className="size-3" />
            </span>
          )}
        </Link>
        <div data-row-actions className={rowActionsClassName}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={m.sidebar_unsent_discard_label({ title })}
            title={m.sidebar_unsent_discard()}
            onClick={discard}
          >
            <CloseIcon aria-hidden />
          </Button>
        </div>
      </div>
    </SidebarRow>
  )
}

type RowMode = "idle" | "renaming" | "archive" | "delete"

const forksSessions = { claude: true, codex: true, muse: false, opencode: false, magpie: true } satisfies Record<
  ProviderId,
  boolean
>

interface ThreadRowProps {
  readonly thread: Thread
  readonly nested: boolean
  readonly index: number
  readonly group: string
  readonly reorderable: boolean
  readonly showProject: boolean
  readonly showActivity: boolean
  readonly linkRef: RefObject<HTMLAnchorElement | null> | undefined
  readonly focusAfterRemoval: () => HTMLElement | null
}

// oxlint-disable-next-line hinacode/no-manual-memo
const ThreadRow = memo(function ThreadRow({
  thread,
  nested,
  index,
  group,
  reorderable,
  showProject,
  showActivity,
  linkRef,
  focusAfterRemoval,
}: ThreadRowProps) {
  const { ref, handleRef, isDragSource } = useSortable({ id: thread.id, index, group, disabled: !reorderable })
  const router = useRouter()
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
  const settled = group === SETTLED_GROUP || thread.settledAt !== null
  const reopenable = archived || settled
  const state = useThreadRowState(thread)
  const dimmed = showProject && rowEmphasis[state] === "resting"
  const meta = useThreadMeta(thread, showProject)
  const rowCloud = showProject ? cloud : undefined
  const hasMeta = meta.project !== null || rowCloud !== undefined || meta.links.length > 0
  const detail = useRowDetail(thread, state, showActivity, showProject)
  const branch = useThreadBranch(thread, worktree)
  const drafted = useDrafts((drafts) => {
    const draft = drafts.byThreadId[thread.id]
    return draft !== undefined && hasContent(draft)
  })
  const when = drafted ? m.sidebar_thread_draft() : <ActivityTime {...meta} />

  const moveOut = (updated: Thread) => {
    flushSync(() => useThreads.getState().upsert(updated))
    if (document.activeElement === document.body) focusAfterRemoval()?.focus({ preventScroll: true })
  }
  const archive = async () => {
    try {
      if (
        archiveSettings.removeWorktree &&
        worktree &&
        (await callPromise("worktrees.checkoutState", { id: worktree.id })) === "dirty"
      ) {
        setMode("archive")
        return
      }
      moveOutArchived(await callPromise("threads.archive", { threadId: thread.id }))
    } catch (cause) {
      toast.error(m.sidebar_archive_failed({ message: errorMessage(cause) }))
    }
  }
  const moveOutArchived = (updated: Thread) => {
    moveOut(updated)
    toast(m.sidebar_thread_archived({ title: updated.title }), {
      action: { label: m.common_undo(), onClick: () => void unarchive() },
    })
  }
  const unarchive = async () => {
    try {
      moveOut(await callPromise("threads.unarchive", { threadId: thread.id }))
    } catch (cause) {
      toast.error(m.sidebar_unarchive_failed({ message: errorMessage(cause) }))
    }
  }
  const settle = async () => {
    try {
      const updated = await callPromise("threads.settle", { threadId: thread.id })
      moveOut(updated)
      toast(m.sidebar_thread_settled({ title: updated.title }), {
        action: { label: m.common_undo(), onClick: () => void unsettle() },
      })
    } catch (cause) {
      toast.error(m.sidebar_settle_failed({ message: errorMessage(cause) }))
    }
  }
  const unsettle = async () => {
    try {
      moveOut(await callPromise("threads.unsettle", { threadId: thread.id }))
    } catch (cause) {
      toast.error(m.sidebar_unarchive_failed({ message: errorMessage(cause) }))
    }
  }
  const reopen = archived ? unarchive : unsettle
  const fork = async () => {
    try {
      const forked = await callPromise("threads.fork", { threadId: thread.id })
      useThreads.getState().upsert(forked)
      await router.navigate({ to: "/thread/$threadId", params: { threadId: forked.id } })
      useUi.getState().requestComposerFocus()
    } catch (cause) {
      toast.error(m.sidebar_fork_failed({ message: errorMessage(cause) }))
    }
  }
  const regenerateTitle = async () => {
    const toastId = toast.loading(m.sidebar_title_regenerating())
    try {
      useThreads.getState().upsert(await callPromise("threads.regenerateTitle", { threadId: thread.id }))
      toast.dismiss(toastId)
    } catch (cause) {
      toast.error(m.sidebar_regenerate_title_failed({ message: errorMessage(cause) }), { id: toastId })
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
    <SidebarRow
      // FIXME: dnd-kit marks a handleless row as a button, which reads as disabled without a handle
      ref={reorderable ? ref : undefined}
      data-dragging={isDragSource}
      data-menu-open={menuOpen || mode === "delete"}
      data-emphasis={rowEmphasis[state]}
      data-dimmed={dimmed}
      data-show-project={meta.project !== null}
      data-archived={archived}
      data-nested={nested}
      data-stale={isStale(cloud)}
      data-meta={hasMeta}
      onPointerEnter={(event) => scrollTitle(event.currentTarget)}
      onPointerLeave={(event) => stopTitle(event.currentTarget)}
      className={rowClassName}
    >
      {meta.project !== null && <ProjectLine project={meta.project} projectId={thread.projectId} trailing={when} />}
      {mode === "renaming" ? (
        <RenameInput thread={thread} onDone={finishRename} />
      ) : (
        <div className="grid grid-cols-1">
          <Link
            ref={linkRef}
            to="/thread/$threadId"
            params={{ threadId: thread.id }}
            draggable={false}
            aria-description={drafted ? m.sidebar_thread_draft() : undefined}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenuOpen(true)
            }}
            data-reorderable={reorderable}
            className={rowLinkClassName}
          >
            <span
              dir="auto"
              className="min-w-0 flex-1 truncate text-left text-sm group-hover/thread:text-clip group-data-[emphasis=attention]/thread:font-medium"
              title={thread.title}
            >
              <span data-title-text className="group-hover/thread:inline-block">
                {thread.title}
              </span>
            </span>
            <StatusIndicator state={state} />
            {meta.project === null && (
              <span aria-hidden className="flex shrink-0 items-center gap-2 text-xs text-sidebar-meta">
                <span className="min-w-8 text-end cjk:min-w-10">{when}</span>
                <ThreadProviderIcon provider={meta.provider} model={meta.model} className="size-3" />
              </span>
            )}
          </Link>
          <div data-row-actions className={rowActionsClassName}>
            {reopenable ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={m.sidebar_thread_unarchive_label({ title: thread.title })}
                title={m.sidebar_thread_unarchive()}
                action={reopen}
              >
                <UnarchiveIcon aria-hidden />
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
                    className="cursor-grab not-focus-visible:sr-only"
                  >
                    <GripIcon aria-hidden />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={m.snooze_label({ title: thread.title })}
                  title={m.sidebar_thread_snooze()}
                  onClick={() => useUi.getState().setSnoozeThreadId(thread.id)}
                >
                  <SnoozeIcon aria-hidden className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={m.sidebar_thread_settle_label({ title: thread.title })}
                  title={m.sidebar_thread_settle()}
                  disabled={busy}
                  action={settle}
                >
                  <CheckIcon aria-hidden className="size-4" />
                </Button>
              </>
            )}
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
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={m.sidebar_thread_actions({ title: thread.title })}
                  />
                }
              >
                <MoreIcon aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={queue("renaming")}>
                    <PencilIcon aria-hidden />
                    {m.sidebar_thread_rename()}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void regenerateTitle()}>
                    <RefreshIcon aria-hidden />
                    {m.sidebar_thread_regenerate_title()}
                  </DropdownMenuItem>
                  {forksSessions[thread.provider] && (
                    <DropdownMenuItem disabled={busy} onClick={() => void fork()}>
                      <ForkIcon aria-hidden />
                      {m.sidebar_thread_fork()}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(thread.id)}>
                    <CopyIcon aria-hidden />
                    {m.sidebar_thread_copy_id()}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {!archived && (
                    <DropdownMenuItem onClick={() => void togglePin()}>
                      {pinned ? <UnpinIcon aria-hidden /> : <PinIcon aria-hidden />}
                      {pinned ? m.sidebar_thread_unpin() : m.sidebar_thread_pin()}
                    </DropdownMenuItem>
                  )}
                  {!reopenable && (
                    <DropdownMenuItem onClick={() => useUi.getState().setSnoozeThreadId(thread.id)}>
                      <SnoozeIcon aria-hidden />
                      {m.sidebar_thread_snooze()}
                    </DropdownMenuItem>
                  )}
                  {!archived && meta.snoozedUntil !== null && (
                    <DropdownMenuItem onClick={() => void snoozeThread(thread, null)}>
                      <AlarmIcon aria-hidden />
                      {m.sidebar_thread_unsnooze()}
                    </DropdownMenuItem>
                  )}
                  {watched.length === 0 ? (
                    <DropdownMenuItem disabled>
                      <EyeOffIcon aria-hidden />
                      {m.sidebar_thread_unwatch()}
                    </DropdownMenuItem>
                  ) : (
                    watched.map((link) => (
                      <DropdownMenuItem key={link.id} onClick={() => void unwatch(link.url)}>
                        <EyeOffIcon aria-hidden />
                        {watched.length > 1
                          ? m.pr_watch_stop({ name: `#${pullRequestNumber(link.url)}` })
                          : m.sidebar_thread_unwatch()}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {reopenable ? (
                    <DropdownMenuItem onClick={() => void reopen()}>
                      <UnarchiveIcon aria-hidden />
                      {m.sidebar_thread_unarchive()}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem disabled={busy} onClick={() => void settle()}>
                      <CheckIcon aria-hidden />
                      {m.sidebar_thread_settle()}
                    </DropdownMenuItem>
                  )}
                  {!archived && (
                    <DropdownMenuItem disabled={busy} onClick={() => void archive()}>
                      <ArchiveIcon aria-hidden />
                      {m.sidebar_thread_archive()}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={busy || isStale(cloud)} onClick={queue("delete")}>
                  <TrashIcon aria-hidden />
                  {m.sidebar_thread_delete()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
      {hasMeta && (
        <ThreadMeta
          links={meta.links}
          threadId={thread.id}
          cloud={rowCloud}
          environment={environment}
          detail={detail}
          ledger={meta.project === null ? null : { provider: meta.provider, model: meta.model, branch }}
        />
      )}
      <DeleteThreadPopover
        thread={thread}
        cloud={cloud}
        anchor={menuTriggerRef}
        open={mode === "delete"}
        onOpenChange={(open) => setMode(open ? "delete" : "idle")}
        focusAfterDelete={focusAfterRemoval}
      />
      {worktree && (
        <ArchiveDialog
          thread={thread}
          worktree={worktree}
          open={mode === "archive"}
          onOpenChange={closeDialog}
          onArchived={moveOutArchived}
        />
      )}
    </SidebarRow>
  )
})

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
      <div className="flex items-center gap-2 px-2.5 pt-1.75 pb-1.5 group-data-[show-project=true]/thread:pt-1">
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
  readonly anchor: RefObject<HTMLElement | null>
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly focusAfterDelete: () => HTMLElement | null
}

function DeleteThreadPopover({
  thread,
  cloud,
  anchor,
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
      <PopoverContent
        side="right"
        align="start"
        anchor={anchor}
        className="w-64"
        finalFocus={() => (useThreads.getState().byId[thread.id] ? anchor.current : focusAfterDelete())}
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

const statusIcons: Partial<Record<RowState, { label: () => string; Icon: IconComponent; className: string }>> = {
  running: { label: m.thread_status_running, ...toIcon(rowStatusIndicator.running) },
  background: { label: m.thread_status_background, ...toIcon(rowStatusIndicator.background) },
  awaiting_approval: {
    label: m.thread_status_awaiting_approval,
    Icon: QuestionIcon,
    className: `${awaiting.className} after:absolute after:inset-0.5 after:animate-attention after:rounded-full after:border after:border-current after:[animation-fill-mode:forwards] motion-reduce:after:hidden`,
  },
  limited: { label: m.thread_status_limited, ...toIcon(rowStatusIndicator.limited), Icon: HourglassIcon },
  unseen_completed: {
    label: m.thread_status_unseen_completed,
    ...toIcon(rowStatusIndicator.unseen_completed),
    Icon: CheckCircleIcon,
  },
  unseen_failed: {
    label: m.thread_status_unseen_failed,
    ...toIcon(rowStatusIndicator.unseen_failed),
    Icon: WarningIcon,
  },
  pr_conflicting: {
    label: m.thread_status_pr_conflicting,
    ...toIcon(rowStatusIndicator.pr_conflicting),
    Icon: RiGitMergeLine,
  },
  pr_checksFailing: {
    label: m.thread_status_pr_checks_failing,
    ...toIcon(rowStatusIndicator.pr_checksFailing),
    Icon: XCircleIcon,
  },
  pr_changesRequested: {
    label: m.thread_status_pr_changes_requested,
    ...toIcon(rowStatusIndicator.pr_changesRequested),
    Icon: FeedbackIcon,
  },
}

const usePullRequestAttention = (thread: Thread) => {
  const environment = useThreadEnvironment(thread.id)
  const links = usePullRequests((state) => state.byThreadId[thread.id]) ?? noLinks
  return useAtomValue(
    pullRequestAttentionAtom(
      environment,
      links.map((link) => link.url),
    ),
  )
}

export function useThreadRowState(thread: Thread): RowState {
  return rowState(
    thread.status,
    useBackgroundTasks((state) => (state.byThreadId[thread.id]?.length ?? 0) > 0),
    useUnseen((unseen) => unseen.byThreadId[thread.id]),
    usePullRequestAttention(thread),
  )
}

const useRowDetail = (thread: Thread, state: RowState, showActivity: boolean, inLedger: boolean) => {
  const attention = usePullRequestAttention(thread)
  const line = useActivity((activity) => activity.byThreadId[thread.id])
  const now = useNow()
  if (!inLedger) return pullRequestDetail(attention)
  return rowDetail({ state, line, limit: thread.usageLimit, attention, showActivity, now, locale: getLocale() })
}

const useThreadBranch = (thread: Thread, worktree: Worktree | undefined) => {
  const root = AsyncResult.getOrElse(useAtomValue(currentBranchAtom(thread.projectId)), () => "")
  const worksInRoot = thread.worktreeId === null && thread.status !== "archived"
  return worksInRoot ? root : (worktree?.branch ?? "")
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
    provider: thread.provider,
    model: thread.model,
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
  detail,
  ledger,
}: {
  links: ReadonlyArray<PullRequestLink>
  threadId: string
  cloud: Cloud | undefined
  environment: EnvironmentId
  detail: RowDetail | null
  ledger: { readonly provider: Thread["provider"]; readonly model: string; readonly branch: string } | null
}) {
  const watching = links.some((link) => link.watch !== null)
  return (
    <div className="flex min-h-5.75 min-w-0 items-center gap-2 px-2.5 pb-1.5 text-xs text-sidebar-meta">
      {cloud && ledger === null && <CloudMark cloud={cloud} className="size-3" />}
      {links.length > 0 && <SidebarPullRequests threadId={threadId} links={links} environment={environment} />}
      {watching && (
        <span title={m.sidebar_watching()} className="flex shrink-0">
          <EyeIcon aria-hidden className="size-3" />
          <span className="sr-only">{m.sidebar_watching()}</span>
        </span>
      )}
      {detail ? (
        <span title={detail.text} className={cn("min-w-0 truncate", detail.code && "font-mono")}>
          {detail.text}
        </span>
      ) : (
        ledger &&
        links.length === 0 &&
        ledger.branch !== "" && (
          <span title={ledger.branch} className="flex min-w-0 items-center gap-1.5">
            <BranchIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{ledger.branch}</span>
          </span>
        )
      )}
      {ledger && (
        <span className="ms-auto flex min-w-0 shrink-0 items-center gap-2 ps-2">
          {cloud && (
            <span className="flex max-w-20 min-w-0 items-center gap-1" title={cloud.name}>
              <CloudMark cloud={cloud} className="size-3" />
              <span className="truncate">{cloud.name}</span>
            </span>
          )}
          <ThreadProviderIcon provider={ledger.provider} model={ledger.model} className="size-3" />
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
    const overflow = text.offsetWidth - box.clientWidth + coveredByActions(row, box)
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

function coveredByActions(row: HTMLElement, box: HTMLElement) {
  const actions = row.querySelector("[data-row-actions]")
  if (!actions) return 0
  return Math.max(0, box.getBoundingClientRect().right - actions.getBoundingClientRect().left)
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
      {formatElapsed(updatedAt, now, locale)}
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
      <SnoozeIcon aria-hidden className="size-3" />
      <span className="sr-only">{m.sidebar_snoozed_until({ time })}</span>
      <span aria-hidden>{time}</span>
    </time>
  )
}
