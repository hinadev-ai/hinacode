// oxlint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- the WAI-ARIA tree with aria-activedescendant: focus stays on the tree, which handles the keys for every row, so rows that scroll out of the virtual list never hold focus.
import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { cn } from "cn"
import {
  createElement,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import type { IconType } from "react-icons"
import {
  RiArrowRightSLine,
  RiAtLine,
  RiContractUpDownLine,
  RiFileCodeLine,
  RiFileCopyLine,
  RiFileLine,
  RiFileMusicLine,
  RiFileTextLine,
  RiFileVideoLine,
  RiFolderLine,
  RiFolderOpenLine,
  RiImageLine,
  RiLinksLine,
  RiMarkdownLine,
  RiRefreshLine,
} from "react-icons/ri"
import { type FsEntry, isThreadBusy, type Thread } from "../../shared/domain.ts"
import { extensionOf, type FilePreview, previewOf } from "../lib/filePreview.ts"
import { useThreadEnvironment } from "../lib/environments.ts"
import { callPromise, onPushEvent } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useDrafts } from "../stores/drafts.ts"
import { emptyTree, flattenTree, parentOf, type TreeRow, useExplorer } from "../stores/explorer.ts"
import { useUi } from "../stores/ui.ts"
import { fileStatusLabel, fileStatusMark } from "./FilePatch.tsx"
import { FileViewer } from "./FileViewer.tsx"
import { Button } from "./ui/button.tsx"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "./ui/context-menu.tsx"
import { DropdownMenuItem } from "./ui/dropdown-menu.tsx"

const ROW_HEIGHT = 24
const INDENT = 12
const TYPEAHEAD_RESET_MS = 600
const DEFAULT_TREE_HEIGHT = 240
const MIN_PANE_HEIGHT = 96

const iconsByPreview: Readonly<Record<FilePreview, IconType>> = {
  image: RiImageLine,
  svg: RiImageLine,
  video: RiFileVideoLine,
  audio: RiFileMusicLine,
  html: RiFileCodeLine,
}

const iconsByExtension: Readonly<Record<string, IconType>> = {
  md: RiMarkdownLine,
  mdx: RiMarkdownLine,
  txt: RiFileTextLine,
  json: RiFileTextLine,
  yaml: RiFileTextLine,
  yml: RiFileTextLine,
  toml: RiFileTextLine,
}
const CODE = /^(ts|tsx|js|jsx|mjs|cjs|css|html|py|rs|go|rb|java|kt|swift|c|h|cpp|sh|sql)$/

const fileIcon = (entry: FsEntry, expanded: boolean): IconType => {
  if (entry.kind === "dir") return expanded ? RiFolderOpenLine : RiFolderLine
  if (entry.kind === "symlink") return RiLinksLine
  const preview = previewOf(entry.name)
  if (preview !== null) return iconsByPreview[preview]
  const extension = extensionOf(entry.name)
  return iconsByExtension[extension] ?? (CODE.test(extension) ? RiFileCodeLine : RiFileLine)
}

/** Every folder from the root down to `path`, which all list something that may have changed with it. */
const foldersDownTo = (path: string) =>
  path === "" ? [""] : ["", ...path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))]

interface FileExplorerProps {
  readonly thread: Thread
  /** The thread's working directory: its worktree, or the project root. */
  readonly root: string
  /** Set when `root` is a live worktree, whose changes can be shown as diffs. */
  readonly worktreeId: string | null
}

/**
 * The files of a thread's working directory as a lazily listed, virtualized WAI-ARIA tree. Focus stays on
 * the tree and `aria-activedescendant` points at the selected row, so rows can scroll out of the DOM.
 */
export function FileExplorer({ thread, root, worktreeId }: FileExplorerProps) {
  const canReveal = useThreadEnvironment(thread.id) === null
  const tree = useExplorer((state) => state.byRoot[root] ?? emptyTree)
  const load = useExplorer((state) => state.load)
  const refresh = useExplorer((state) => state.refresh)
  const expand = useExplorer((state) => state.expand)
  const collapse = useExplorer((state) => state.collapse)
  const collapseAll = useExplorer((state) => state.collapseAll)
  const select = useExplorer((state) => state.select)
  const openFile = useExplorer((state) => state.open)
  const rows = useMemo(() => flattenTree(tree), [tree])
  const selectedIndex = rows.findIndex((row) => row.entry.path === tree.selected)
  const [announcement, setAnnouncement] = useState("")
  const treeRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<LegendListRef>(null)
  const typeahead = useRef({ text: "", at: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const [treeHeight, setTreeHeight] = useState(DEFAULT_TREE_HEIGHT)
  const rowId = `${useId()}-row-`

  useEffect(() => {
    void refresh(root)
  }, [refresh, root])

  const watched = useMemo(
    () => [...new Set(["", ...tree.expanded, ...(tree.opened === null ? [] : [parentOf(tree.opened)])])],
    [tree.expanded, tree.opened],
  )
  useEffect(() => {
    callPromise("fs.watch", { root, paths: watched }).catch(() => undefined)
  }, [root, watched])
  useEffect(() => () => void callPromise("fs.watch", { root, paths: [] }).catch(() => undefined), [root])

  useEffect(
    () =>
      onPushEvent((event) => {
        if (event.type !== "fs.changed" || event.root !== root) return
        const { expanded } = useExplorer.getState().byRoot[root] ?? emptyTree
        for (const folder of foldersDownTo(event.path)) {
          if (folder === "" || expanded.has(folder)) void load(root, folder)
        }
      }),
    [load, root],
  )

  // A turn can commit or stage without touching a watched folder, which changes the colors.
  const busy = isThreadBusy(thread.status)
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) void refresh(root)
    wasBusy.current = busy
  }, [busy, refresh, root])

  // The tree element only exists once the root is listed, so a request made on mount waits for that.
  const focusRequested = useUi((state) => state.viewFocusRequest === "files")
  const loaded = tree.children[""] !== undefined || tree.error !== null
  useEffect(() => {
    if (!focusRequested || !loaded) return
    useUi.getState().clearViewFocusRequest()
    // After the side panel dialog, if any, has placed its own initial focus.
    requestAnimationFrame(() => treeRef.current?.focus())
  }, [focusRequested, loaded])

  useEffect(() => {
    if (selectedIndex >= 0) void listRef.current?.scrollIndexIntoView({ index: selectedIndex, animated: false })
  }, [selectedIndex])

  const selectedEntry = rows[selectedIndex]?.entry
  const hasDiff = (entry: FsEntry) => worktreeId !== null && entry.kind === "file" && entry.gitStatus !== null

  const mention = (entry: FsEntry) => {
    const path = entry.kind === "dir" ? `${entry.path}/` : entry.path
    useDrafts.getState().appendMention(thread.id, path)
    setAnnouncement(m.explorer_mentioned({ path: `@${path}` }))
  }

  const toggle = (entry: FsEntry) =>
    tree.expanded.has(entry.path) ? collapse(root, entry.path) : expand(root, entry.path)

  const open = (entry: FsEntry) => (entry.kind === "dir" ? toggle(entry) : openFile(root, entry.path))

  const closeFile = () => {
    openFile(root, null)
    treeRef.current?.focus()
  }

  // A file needs the room an editor gets.
  const fileOpen = tree.opened !== null
  useEffect(() => {
    useUi.getState().setSidePanelWide(fileOpen)
    return () => useUi.getState().setSidePanelWide(false)
  }, [fileOpen])

  const showChanges = (entry: FsEntry) => {
    useUi.getState().setChangesPath(entry.path)
    useUi.getState().showView(thread.id, "changes")
  }

  const moveTo = (index: number) => {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))]
    if (row) select(root, row.entry.path)
  }

  /** Selects the next entry whose name starts with what was typed. Typing one letter again cycles. */
  const jump = (key: string) => {
    const now = performance.now()
    const state = typeahead.current
    state.text = now - state.at > TYPEAHEAD_RESET_MS ? key.toLowerCase() : state.text + key.toLowerCase()
    state.at = now
    const start = state.text.length === 1 ? selectedIndex + 1 : Math.max(selectedIndex, 0)
    for (let offset = 0; offset < rows.length; offset++) {
      const row = rows[(start + offset) % rows.length]
      if (row?.entry.name.toLowerCase().startsWith(state.text)) return select(root, row.entry.path)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return
    const current = rows[selectedIndex]
    const entry = current?.entry
    switch (event.key) {
      case "ArrowDown":
        moveTo(selectedIndex + 1)
        break
      case "ArrowUp":
        moveTo(selectedIndex === -1 ? 0 : selectedIndex - 1)
        break
      case "Home":
        moveTo(0)
        break
      case "End":
        moveTo(rows.length - 1)
        break
      case "ArrowRight":
        if (entry?.kind !== "dir") break
        if (!tree.expanded.has(entry.path)) expand(root, entry.path)
        else if (rows[selectedIndex + 1]?.depth === (current?.depth ?? 0) + 1) moveTo(selectedIndex + 1)
        break
      case "ArrowLeft":
        if (entry?.kind === "dir" && tree.expanded.has(entry.path)) collapse(root, entry.path)
        else if (entry && parentOf(entry.path) !== "") select(root, parentOf(entry.path))
        break
      case "Enter":
        if (entry) open(entry)
        break
      case "Escape":
        if (tree.opened === null) return
        openFile(root, null)
        // Closing the file must not also close the side panel dialog around it.
        event.stopPropagation()
        break
      default:
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
        jump(event.key)
    }
    event.preventDefault()
  }

  const onFocus = () => {
    if (selectedIndex === -1 && rows[0]) select(root, rows[0].entry.path)
  }

  const onRowClick = (entry: FsEntry) => {
    select(root, entry.path)
    treeRef.current?.focus()
    open(entry)
  }

  const renderItem = ({ item, index }: { item: TreeRow; index: number }) => (
    <TreeItem
      row={item}
      id={`${rowId}${index}`}
      selected={index === selectedIndex}
      expanded={tree.expanded.has(item.entry.path)}
      unsaved={item.entry.path in tree.unsaved}
      onClick={onRowClick}
      onContextMenu={(entry) => select(root, entry.path)}
    />
  )

  const listed = tree.children[""]
  const rootName = root.slice(root.lastIndexOf("/") + 1)

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={root}>
          {rootName}
        </span>
        <HeaderButton label={m.explorer_collapse_all()} onClick={() => collapseAll(root)} icon={RiContractUpDownLine} />
        {canReveal && (
          <HeaderButton
            label={m.panel_reveal()}
            onClick={() => void callPromise("shell.reveal", { path: root })}
            icon={RiFolderOpenLine}
          />
        )}
        <HeaderButton label={m.explorer_refresh()} onClick={() => void refresh(root)} icon={RiRefreshLine} />
      </header>
      <div
        className={cn("flex min-h-0 flex-col", tree.opened === null ? "flex-1" : "shrink-0")}
        style={tree.opened === null ? undefined : { height: treeHeight }}
      >
        {tree.error !== null ? (
          <p role="alert" className="p-3 text-xs text-destructive">
            {m.explorer_failed({ message: tree.error })}
          </p>
        ) : listed === undefined ? (
          <p className="animate-reveal p-3 text-xs text-muted-foreground">{m.explorer_loading()}</p>
        ) : listed.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{m.explorer_empty()}</p>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger
              render={
                <div
                  ref={treeRef}
                  role="tree"
                  tabIndex={0}
                  aria-label={m.explorer_tree()}
                  aria-activedescendant={selectedIndex >= 0 ? `${rowId}${selectedIndex}` : undefined}
                  onKeyDown={onKeyDown}
                  onFocus={onFocus}
                  className="group/tree flex min-h-0 flex-1 flex-col py-1 outline-none"
                />
              }
            >
              <LegendList
                ref={listRef}
                data={rows}
                keyExtractor={(row) => row.entry.path}
                renderItem={renderItem}
                extraData={tree}
                estimatedItemSize={ROW_HEIGHT}
                getFixedItemSize={() => ROW_HEIGHT}
                className="min-h-0 flex-1"
              />
            </ContextMenuTrigger>
            {selectedEntry && (
              <ContextMenuContent>
                <DropdownMenuItem onClick={() => mention(selectedEntry)}>
                  <RiAtLine aria-hidden />
                  {m.explorer_mention()}
                </DropdownMenuItem>
                {hasDiff(selectedEntry) && (
                  <DropdownMenuItem onClick={() => showChanges(selectedEntry)}>
                    <RiFileTextLine aria-hidden />
                    {m.explorer_show_changes()}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(selectedEntry.path)}>
                  <RiFileCopyLine aria-hidden />
                  {m.explorer_copy_path()}
                </DropdownMenuItem>
                {canReveal && (
                  <DropdownMenuItem
                    onClick={() => void callPromise("shell.reveal", { path: `${root}/${selectedEntry.path}` })}
                  >
                    <RiFolderOpenLine aria-hidden />
                    {m.panel_reveal()}
                  </DropdownMenuItem>
                )}
              </ContextMenuContent>
            )}
          </ContextMenu>
        )}
      </div>
      {tree.opened !== null && (
        <>
          <SplitHandle height={treeHeight} onResize={setTreeHeight} container={containerRef} />
          <FileViewer threadId={thread.id} root={root} path={tree.opened} onClose={closeFile} />
        </>
      )}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}

function HeaderButton({ label, icon: Icon, onClick }: { label: string; icon: IconType; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-xs" aria-label={label} title={label} onClick={onClick}>
      <Icon aria-hidden />
    </Button>
  )
}

interface SplitHandleProps {
  readonly height: number
  readonly onResize: (height: number) => void
  /** The explorer, whose height bounds the tree's. */
  readonly container: RefObject<HTMLDivElement | null>
}

/** The WAI-ARIA window splitter between the tree and the file viewer, dragged or moved with Up and Down. */
function SplitHandle({ height, onResize, container }: SplitHandleProps) {
  const max = () => Math.max(MIN_PANE_HEIGHT, (container.current?.clientHeight ?? 0) - MIN_PANE_HEIGHT * 2)
  const resize = (next: number) => onResize(Math.round(Math.min(Math.max(next, MIN_PANE_HEIGHT), max())))

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const startY = event.clientY
    const startHeight = height
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const move = (moveEvent: globalThis.PointerEvent) => resize(startHeight + moveEvent.clientY - startY)
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
    const step = { ArrowUp: -ROW_HEIGHT, ArrowDown: ROW_HEIGHT }[event.key]
    if (step === undefined) return
    event.preventDefault()
    resize(height + step)
  }

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a focusable window splitter, which <hr> is not.
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={m.viewer_resize()}
      aria-valuenow={height}
      aria-valuemin={MIN_PANE_HEIGHT}
      aria-valuemax={max()}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="relative h-px shrink-0 cursor-row-resize touch-none bg-border outline-none before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-ring focus-visible:bg-ring focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}

interface TreeItemProps {
  readonly row: TreeRow
  readonly id: string
  readonly selected: boolean
  readonly expanded: boolean
  readonly unsaved: boolean
  readonly onClick: (entry: FsEntry) => void
  readonly onContextMenu: (entry: FsEntry) => void
}

function TreeItem({ row, id, selected, expanded, unsaved, onClick, onContextMenu }: TreeItemProps) {
  const { entry, depth } = row
  const isDir = entry.kind === "dir"
  const mark = entry.gitStatus === null ? null : fileStatusMark[entry.gitStatus]
  const description = [
    unsaved && m.viewer_unsaved(),
    entry.gitStatus && fileStatusLabel[entry.gitStatus](),
    entry.ignored && m.explorer_ignored(),
  ]
    .filter(Boolean)
    .join(", ")

  return (
    <div
      id={id}
      role="treeitem"
      aria-level={depth + 1}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-selected={selected}
      aria-expanded={isDir ? expanded : undefined}
      aria-describedby={description ? `${id}-status` : undefined}
      onClick={() => onClick(entry)}
      onContextMenu={() => onContextMenu(entry)}
      style={{ paddingLeft: 8 + depth * INDENT }}
      className="relative mx-1 flex h-6 cursor-default items-center gap-1 rounded-md pr-2 text-[0.8125rem] select-none hover:bg-muted/60 aria-selected:bg-muted group-focus/tree:aria-selected:ring-1 group-focus/tree:aria-selected:ring-ring group-focus/tree:aria-selected:ring-inset"
    >
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="absolute inset-y-0 w-px bg-border"
          style={{ left: 8 + level * INDENT + 7 }}
        />
      ))}
      <RiArrowRightSLine
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
          !isDir && "invisible",
          expanded && "rotate-90",
        )}
      />
      {createElement(fileIcon(entry, expanded), {
        "aria-hidden": true,
        className: "size-3.5 shrink-0 text-muted-foreground",
      })}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          entry.ignored && "text-muted-foreground",
          mark?.className,
          entry.kind === "symlink" && "italic",
        )}
      >
        {entry.name}
      </span>
      {description && (
        <span id={`${id}-status`} hidden>
          {description}
        </span>
      )}
      {unsaved && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-foreground" />}
      {mark && (
        <span aria-hidden className={cn("shrink-0 font-mono text-2xs", mark.className)}>
          {mark.letter}
        </span>
      )}
    </div>
  )
}
