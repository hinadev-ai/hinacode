// oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/interactive-supports-focus, jsx-a11y/click-events-have-key-events -- the WAI-ARIA listbox pattern with aria-activedescendant, which <select> cannot render: the listbox keeps focus and handles keys, a click on an option only moves the selection. The divider is a focusable WAI-ARIA window splitter.
import { useAtom, useAtomRefresh, useAtomSuspense, useAtomValue } from "@effect/atom-react"
import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { parsePatchFiles } from "@pierre/diffs"
import { FileDiff } from "@pierre/diffs/react"
import { cn } from "cn"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import { RiPriceTag3Line, RiRefreshLine } from "react-icons/ri"
import type { GitCommit, Thread } from "../../shared/domain.ts"
import { useTheme } from "../lib/appearance.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { chipRefs, type GraphEdge, type GraphRow, laneCount, layoutGraph } from "../lib/gitGraph.ts"
import { commitDiffAtom, commitKey, currentBranchAtom, gitLogAtom, gitLogLimitAtom, projectsAtom } from "../lib/rpc.ts"
import { GIT_GRAPH_SPLIT_BOUNDS } from "../lib/panelSize.ts"
import { useClientSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useUi } from "../stores/ui.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"

const ROW_HEIGHT = 28
const LANE_INSET = 8
const NODE_RADIUS = 3.5
/** Lanes narrow down to `MIN_LANE_WIDTH` to fit this width, so the subject keeps room in the side panel. */
const MAX_GRAPH_WIDTH = 112
const MAX_LANE_WIDTH = 12
const MIN_LANE_WIDTH = 8
const LANE_COLORS = 6
const PAGE_SIZE = 500
const MAX_COMMITS = 10_000

/**
 * The commit graph of the checkout a thread works in: its worktree, or the project root when the thread
 * has none. Selecting a commit shows its diff below the list.
 */
export function GitGraphView({ thread }: { thread: Thread }) {
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const project = projects.find((candidate) => candidate.id === thread.projectId)
  const inWorktree = worktree !== undefined && worktree.status !== "removed"
  const rootBranch = AsyncResult.getOrElse(useAtomValue(currentBranchAtom(thread.projectId)), () => undefined)
  const root = inWorktree ? worktree.path : project?.rootPath
  if (!root) return null
  return (
    <GitGraph key={root} root={root} branch={inWorktree ? worktree.branch : rootBranch} threadStatus={thread.status} />
  )
}

function GitGraph({ root, branch, threadStatus }: { root: string; branch?: string; threadStatus: Thread["status"] }) {
  const logAtom = gitLogAtom(root)
  const log = useAtomValue(logAtom)
  const refresh = useAtomRefresh(logAtom)
  const [limit, setLimit] = useAtom(gitLogLimitAtom(root))

  // A turn ending is when an agent's commits land, so a status change asks again.
  const lastStatus = useRef(threadStatus)
  useEffect(() => {
    if (lastStatus.current === threadStatus) return
    lastStatus.current = threadStatus
    refresh()
  }, [threadStatus, refresh])

  const commits = AsyncResult.getOrElse(log, () => [] as ReadonlyArray<GitCommit>)
  const loadMore = () => {
    if (!log.waiting && commits.length === limit && limit < MAX_COMMITS)
      setLimit(Math.min(limit + PAGE_SIZE, MAX_COMMITS))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <h3 className="text-xs font-medium text-muted-foreground">{m.git_graph_label()}</h3>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={m.git_graph_refresh()}
          title={m.git_graph_refresh()}
          onClick={refresh}
        >
          <RiRefreshLine
            aria-hidden
            className={log.waiting ? "animate-spin-late motion-reduce:animate-none" : undefined}
          />
        </Button>
      </div>
      {AsyncResult.builder(log)
        .onInitial(() => <Notice className="animate-reveal">{m.git_graph_loading()}</Notice>)
        .onSuccess((loaded) =>
          loaded.length === 0 ? (
            <Notice>{m.git_graph_empty()}</Notice>
          ) : (
            <GraphWithDiff root={root} branch={branch} commits={loaded} onEndReached={loadMore} />
          ),
        )
        .onError((error) => <Notice alert>{m.git_graph_failed({ message: errorMessage(error) })}</Notice>)
        .orElse(() => null)}
    </div>
  )
}

function Notice({ children, alert = false, className }: { children: string; alert?: boolean; className?: string }) {
  return (
    <p
      role={alert ? "alert" : undefined}
      className={cn("p-3 text-xs", alert ? "text-destructive" : "text-muted-foreground", className)}
    >
      {children}
    </p>
  )
}

interface GraphWithDiffProps {
  readonly root: string
  readonly branch: string | undefined
  readonly commits: ReadonlyArray<GitCommit>
  readonly onEndReached: () => void
}

function GraphWithDiff({ root, branch, commits, onEndReached }: GraphWithDiffProps) {
  const listId = useId()
  const listRef = useRef<LegendListRef>(null)
  const rows = useMemo(() => layoutGraph(commits), [commits])
  const lanes = Math.max(laneCount(rows), 1)
  const laneWidth = Math.min(Math.max(MAX_GRAPH_WIDTH / lanes, MIN_LANE_WIDTH), MAX_LANE_WIDTH)
  const graph = useMemo(
    () => ({ laneWidth, width: Math.min(LANE_INSET * 2 + (lanes - 1) * laneWidth, MAX_GRAPH_WIDTH) }),
    [laneWidth, lanes],
  )
  const [selected, setSelected] = useState<string | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const split = useUi((state) => state.gitGraphSplit)
  const setSplit = useUi((state) => state.setGitGraphSplit)
  const selectedIndex = selected === null ? -1 : rows.findIndex((row) => row.commit.hash === selected)
  const selectedCommit = rows[selectedIndex]?.commit

  const select = useCallback(
    (index: number) => {
      const row = rows[index]
      if (!row) return
      setSelected(row.commit.hash)
      void listRef.current?.scrollIndexIntoView({ index, animated: false })
    },
    [rows],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowDown: selectedIndex + 1,
      ArrowUp: Math.max(selectedIndex - 1, 0),
      Home: 0,
      End: rows.length - 1,
    }
    const next = moves[event.key]
    if (next !== undefined) {
      event.preventDefault()
      select(Math.min(next, rows.length - 1))
    } else if (event.key === "Enter" && selectedCommit) {
      event.preventDefault()
      setDiffOpen((open) => !open)
    }
  }

  const renderItem = useCallback(
    ({ item, index }: { item: GraphRow; index: number }) => (
      <CommitRow
        id={`${listId}-${item.commit.hash}`}
        row={item}
        incoming={rows[index - 1]?.edges ?? []}
        graph={graph}
        branch={branch}
        selected={item.commit.hash === selected}
        onSelect={() => {
          setSelected(item.commit.hash)
          setDiffOpen(true)
        }}
      />
    ),
    [listId, rows, graph, branch, selected],
  )

  const showDiff = diffOpen && selectedCommit !== undefined
  // A diff needs the room a file viewer gets.
  useEffect(() => {
    useUi.getState().setSidePanelWide(showDiff)
    return () => useUi.getState().setSidePanelWide(false)
  }, [showDiff])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="listbox"
        aria-label={m.git_graph_label()}
        aria-activedescendant={selectedCommit ? `${listId}-${selectedCommit.hash}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="group/list @container flex min-h-0 flex-col outline-none"
        style={{ flex: showDiff ? `0 0 ${split}%` : "1 1 0%" }}
      >
        <LegendList
          ref={listRef}
          data={rows}
          keyExtractor={rowKey}
          renderItem={renderItem}
          extraData={selected}
          estimatedItemSize={ROW_HEIGHT}
          getFixedItemSize={fixedRowHeight}
          recycleItems
          onEndReached={onEndReached}
          onEndReachedThreshold={2}
          className="min-h-0 flex-1"
        />
      </div>
      {showDiff ? (
        <>
          <SplitHandle value={split} onChange={setSplit} />
          <CommitDiffPane root={root} commit={selectedCommit} />
        </>
      ) : (
        <p className="shrink-0 border-t border-border p-3 text-xs text-muted-foreground">{m.git_graph_hint()}</p>
      )}
    </div>
  )
}

const rowKey = (row: GraphRow) => row.commit.hash
const fixedRowHeight = () => ROW_HEIGHT

interface CommitRowProps {
  readonly id: string
  readonly row: GraphRow
  readonly incoming: ReadonlyArray<GraphEdge>
  readonly graph: GraphSize
  readonly branch: string | undefined
  readonly selected: boolean
  readonly onSelect: () => void
}

const CommitRow = memo(function CommitRow({ id, row, incoming, graph, branch, selected, onSelect }: CommitRowProps) {
  const { commit } = row
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={m.git_graph_commit({ subject: commit.subject, author: commit.author })}
      onClick={onSelect}
      className={cn(
        "flex cursor-default items-center gap-2 pr-3 text-xs select-none hover:bg-muted/50",
        selected &&
          "bg-muted group-focus-visible/list:ring-2 group-focus-visible/list:ring-ring group-focus-visible/list:ring-inset",
      )}
      style={{ height: ROW_HEIGHT }}
    >
      <GraphLanes row={row} incoming={incoming} graph={graph} />
      <RefChips refs={commit.refs} branch={branch} />
      <span className="min-w-0 flex-1 truncate" title={commit.subject}>
        {commit.subject}
      </span>
      <span className="hidden max-w-28 shrink-0 truncate text-muted-foreground @md:block" title={commit.author}>
        {commit.author}
      </span>
      <time
        dateTime={commit.authoredAt}
        title={new Date(commit.authoredAt).toLocaleString(getLocale())}
        className="shrink-0 text-muted-foreground tabular-nums"
      >
        {relativeTime(commit.authoredAt)}
      </time>
    </div>
  )
})

interface GraphSize {
  readonly laneWidth: number
  readonly width: number
}

const laneColor = (lane: number) => `var(--graph-lane-${lane % LANE_COLORS})`

/**
 * Each edge spans two rows, from one center line to the next. A row draws the whole curve of the
 * previous row's edges and of its own, and its viewport clips each to the half that falls inside it.
 */
function GraphLanes({ row, incoming, graph }: { row: GraphRow; incoming: ReadonlyArray<GraphEdge>; graph: GraphSize }) {
  const laneX = (lane: number) => LANE_INSET + lane * graph.laneWidth
  const center = ROW_HEIGHT / 2
  /** A line between center lines `y` and `y + ROW_HEIGHT`, curving when it changes lanes. */
  const edge = ({ fromLane, toLane }: GraphEdge, y: number, key: string) => {
    const x1 = laneX(fromLane)
    const x2 = laneX(toLane)
    const middle = y + ROW_HEIGHT / 2
    const d =
      x1 === x2
        ? `M${x1} ${y}V${y + ROW_HEIGHT}`
        : `M${x1} ${y}C${x1} ${middle} ${x2} ${middle} ${x2} ${y + ROW_HEIGHT}`
    return <path key={key} d={d} stroke={laneColor(Math.max(fromLane, toLane))} strokeWidth={1.5} />
  }
  const merge = row.commit.parents.length > 1
  return (
    <svg aria-hidden width={graph.width} height={ROW_HEIGHT} className="shrink-0 overflow-hidden" fill="none">
      {incoming.map((line, index) => edge(line, center - ROW_HEIGHT, `in-${index}`))}
      {row.edges.map((line, index) => edge(line, center, `out-${index}`))}
      <circle
        cx={laneX(row.lane)}
        cy={center}
        r={NODE_RADIUS}
        fill={merge ? "var(--background)" : laneColor(row.lane)}
        stroke={laneColor(row.lane)}
        strokeWidth={1.5}
      />
    </svg>
  )
}

/** One chip keeps the subject readable in the side panel; the rest are counted, and named on hover. */
function RefChips({ refs, branch }: { refs: ReadonlyArray<string>; branch: string | undefined }) {
  // The thread's branch names the row best, then HEAD; both are what the thread is working on.
  const rank = (ref: string) => (ref === branch ? 2 : ref === "HEAD" ? 1 : 0)
  const shown = chipRefs(refs).toSorted((a, b) => rank(b) - rank(a))
  const first = shown[0]
  if (first === undefined) return null
  const tag = first.startsWith("tag: ") ? first.slice("tag: ".length) : undefined
  const emphasized = rank(first) > 0
  return (
    <span className="flex max-w-[40%] min-w-0 shrink-0 items-center gap-1" title={refs.join(", ")}>
      <Badge
        variant="outline"
        className={cn(
          "h-4 min-w-0 shrink px-1.5 font-mono text-2xs font-normal",
          emphasized ? "border-working/50 bg-working/10 text-working" : "text-muted-foreground",
        )}
      >
        {tag !== undefined && <RiPriceTag3Line aria-hidden />}
        <span className="truncate">{tag ?? first}</span>
      </Badge>
      {shown.length > 1 && (
        <span className="shrink-0 text-2xs text-muted-foreground">
          {m.git_graph_more_refs({ count: shown.length - 1 })}
        </span>
      )}
    </span>
  )
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
]

const relativeTime = (iso: string) => {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto", style: "narrow" })
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(0, "minute")
}

const { min: MIN_SPLIT, max: MAX_SPLIT } = GIT_GRAPH_SPLIT_BOUNDS

/** The divider between the list and the diff. Dragging or the arrow keys move it. */
function SplitHandle({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const clamp = (next: number) => Math.min(Math.max(next, MIN_SPLIT), MAX_SPLIT)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget
    const container = handle.parentElement
    if (!container) return
    handle.setPointerCapture(event.pointerId)
    const move = (moveEvent: globalThis.PointerEvent) => {
      const bounds = container.getBoundingClientRect()
      onChange(clamp(((moveEvent.clientY - bounds.top) / bounds.height) * 100))
    }
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
    const step = { ArrowUp: -5, ArrowDown: 5 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    onChange(clamp(value + step))
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={m.git_graph_resize()}
      aria-valuenow={Math.round(value)}
      aria-valuemin={MIN_SPLIT}
      aria-valuemax={MAX_SPLIT}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="relative h-px shrink-0 cursor-row-resize touch-none bg-border outline-none before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] hover:bg-ring/50 focus-visible:h-0.5 focus-visible:bg-ring"
    />
  )
}

function CommitDiffPane({ root, commit }: { root: string; commit: GitCommit }) {
  // Moving through commits keeps the last diff on screen until the next one loads.
  const shownHash = useDeferredValue(commit.hash)
  return (
    <section
      aria-label={m.git_graph_diff_label({ hash: commit.hash.slice(0, 7) })}
      className="flex min-h-0 flex-1 animate-fade-in flex-col motion-reduce:animate-none"
    >
      <div className="flex shrink-0 items-baseline gap-2 px-3 py-2 text-xs">
        <code className="shrink-0 font-mono text-muted-foreground">{commit.hash.slice(0, 7)}</code>
        <span className="min-w-0 truncate font-medium" title={commit.subject}>
          {commit.subject}
        </span>
      </div>
      <ScrollArea
        className={cn("min-h-0 flex-1 transition-opacity", shownHash !== commit.hash && "opacity-60 delay-150")}
      >
        <Suspense fallback={<Notice className="animate-reveal">{m.git_graph_diff_loading()}</Notice>}>
          <CommitFiles key={shownHash} root={root} hash={shownHash} />
        </Suspense>
      </ScrollArea>
    </section>
  )
}

function CommitFiles({ root, hash }: { root: string; hash: string }) {
  const diff = useAtomSuspense(commitDiffAtom(commitKey(root, hash)), { includeFailure: true })
  const theme = useTheme(useClientSettings().appearance.theme)
  const patch = AsyncResult.isSuccess(diff) ? diff.value.patch : ""
  const files = useMemo(() => parsePatchFiles(patch, `commit-${hash}`).flatMap((parsed) => parsed.files), [patch, hash])
  if (AsyncResult.isFailure(diff)) {
    return <Notice alert>{m.git_graph_diff_failed({ message: errorMessage(Cause.squash(diff.cause)) })}</Notice>
  }
  if (files.length === 0) return <Notice>{m.git_graph_diff_empty()}</Notice>
  return (
    <div className="flex flex-col gap-2 px-3 pb-3 text-xs">
      {files.map((file) => (
        <div key={file.name} className="overflow-hidden rounded-md border border-border">
          <FileDiff
            fileDiff={file}
            options={{ diffStyle: "unified", theme: theme.codeTheme, themeType: theme.scheme, overflow: "wrap" }}
          />
        </div>
      ))}
    </div>
  )
}
