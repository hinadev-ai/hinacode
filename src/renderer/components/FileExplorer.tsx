// oxlint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- the WAI-ARIA tree with aria-activedescendant: focus stays on the tree, which handles the keys for every row, so rows that scroll out of the virtual list never hold focus.
import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { cn } from "cn"
import {
  createElement,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  startTransition,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react"
import { toast } from "sonner"
import { type FsEntry, isThreadBusy, type Thread } from "../../shared/domain.ts"
import { extensionOf, type FilePreview, previewOf } from "../lib/filePreview.ts"
import { useThreadEnvironment } from "../lib/environments.ts"
import { toastError } from "../lib/errorMessage.ts"
import { FILE_TREE_HEIGHT_BOUNDS } from "../lib/panelSize.ts"
import { callPromise, onPushEvent } from "../lib/rpc.ts"
import { inBrowser } from "../lib/runtime.ts"
import { m } from "../paraglide/messages.js"
import { useDrafts } from "../stores/drafts.ts"
import {
  canMoveInto,
  dropFolderOf,
  emptyTree,
  flattenTree,
  isWithin,
  nameOf,
  type NewEntryKind,
  parentOf,
  type TreeRow,
  useExplorer,
} from "../stores/explorer.ts"
import { useUi } from "../stores/ui.ts"
import { fileStatusMark } from "./FilePatch.tsx"
import { FileViewer } from "./FileViewer.tsx"
import { HighlightWorkerPool } from "./HighlightWorkerPool.tsx"
import { Button } from "./ui/button.tsx"
import { OpenWithSubmenu } from "./OpenWith.tsx"
import { DeleteEntryDialog } from "./DeleteEntryDialog.tsx"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "./ui/context-menu.tsx"
import { DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"
import {
  AtIcon,
  ChevronRightIcon,
  CollapseIcon,
  CopyIcon,
  FileAddIcon,
  FileCodeIcon,
  FileDiffIcon,
  FileIcon,
  FileMusicIcon,
  FileTextIcon,
  FileVideoIcon,
  FolderAddIcon,
  FolderIcon,
  FolderOpenIcon,
  type IconComponent,
  ImageIcon,
  LinkIcon,
  MarkdownIcon,
  PencilIcon,
  RefreshIcon,
  TrashIcon,
} from "@hinacode/icons"

const ROW_HEIGHT = 24
const INDENT = 12
const TYPEAHEAD_RESET_MS = 600
const MIN_PANE_HEIGHT = FILE_TREE_HEIGHT_BOUNDS.min
const SPRING_OPEN_MS = 600
const ENTRY_DRAG_TYPE = "application/x-hinacode-entry"
const ROOT_FOLDER = ""

const iconsByPreview: Readonly<Record<FilePreview, IconComponent>> = {
  image: ImageIcon,
  svg: ImageIcon,
  video: FileVideoIcon,
  audio: FileMusicIcon,
  html: FileCodeIcon,
  markdown: MarkdownIcon,
}

const iconsByExtension: Readonly<Record<string, IconComponent>> = {
  mdx: MarkdownIcon,
  txt: FileTextIcon,
  json: FileTextIcon,
  yaml: FileTextIcon,
  yml: FileTextIcon,
  toml: FileTextIcon,
}
const CODE = /^(ts|tsx|js|jsx|mjs|cjs|css|py|rs|go|rb|java|kt|swift|c|h|cpp|sh|sql)$/

const fileIcon = (entry: FsEntry, expanded: boolean): IconComponent => {
  if (entry.kind === "dir") return expanded ? FolderOpenIcon : FolderIcon
  if (entry.kind === "symlink") return LinkIcon
  const preview = previewOf(entry.name)
  if (preview !== null) return iconsByPreview[preview]
  const extension = extensionOf(entry.name)
  return iconsByExtension[extension] ?? (CODE.test(extension) ? FileCodeIcon : FileIcon)
}

const foldersDownTo = (path: string) =>
  path === "" ? [""] : ["", ...path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))]

interface EntryDrag {
  readonly source: string
  readonly over: string | null
}

interface DropEdges {
  readonly top: boolean
  readonly bottom: boolean
}

interface FileExplorerProps {
  readonly thread: Thread
  readonly root: string
  readonly worktreeId: string | null
}

export function FileExplorer({ thread, root, worktreeId }: FileExplorerProps) {
  const canReveal = useThreadEnvironment(thread.id) === null && !inBrowser()
  const rootName = nameOf(root)
  const tree = useExplorer((state) => state.byRoot[root] ?? emptyTree)
  const load = useExplorer((state) => state.load)
  const refresh = useExplorer((state) => state.refresh)
  const expand = useExplorer((state) => state.expand)
  const collapse = useExplorer((state) => state.collapse)
  const collapseAll = useExplorer((state) => state.collapseAll)
  const select = useExplorer((state) => state.select)
  const openFile = useExplorer((state) => state.open)
  const startNaming = useExplorer((state) => state.startNaming)
  const rows = flattenTree(tree)
  const selectedIndex = rows.findIndex((row) => row.kind === "entry" && row.entry.path === tree.selected)
  const [announcement, setAnnouncement] = useState("")
  const [deleting, setDeleting] = useState<FsEntry | null>(null)
  const [drag, setDrag] = useState<EntryDrag | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<LegendListRef>(null)
  const typeahead = useRef({ text: "", at: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const treeHeight = useUi((state) => state.fileTreeHeight)
  const setTreeHeight = useUi((state) => state.setFileTreeHeight)
  const rowId = `${useId()}-row-`

  useEffect(() => {
    void refresh(root)
  }, [refresh, root])

  useEffect(() => {
    const watched = [...new Set(["", ...tree.expanded, ...(tree.opened === null ? [] : [parentOf(tree.opened)])])]
    callPromise("fs.watch", { root, paths: watched }).catch(() => undefined)
  }, [root, tree.expanded, tree.opened])
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

  const busy = isThreadBusy(thread.status)
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) void refresh(root)
    wasBusy.current = busy
  }, [busy, refresh, root])

  const focusRequested = useUi((state) => state.viewFocusRequest === "files")
  const loaded = tree.children[""] !== undefined || tree.error !== null
  useEffect(() => {
    if (!focusRequested || !loaded) return
    useUi.getState().clearViewFocusRequest()
    // FIXME: Base UI Dialog places its initial focus a frame late, which would take focus back
    requestAnimationFrame(() => treeRef.current?.focus())
  }, [focusRequested, loaded])

  // FIXME: scrolling a freshly mounted LegendList before the scroller has its height clamps to 0 and blanks the tree
  const scrolledIndex = useRef(selectedIndex)
  useEffect(() => {
    if (selectedIndex === scrolledIndex.current) return
    scrolledIndex.current = selectedIndex
    if (selectedIndex >= 0) void listRef.current?.scrollIndexIntoView({ index: selectedIndex, animated: false })
  }, [selectedIndex])

  const dropFolder = drag?.over ?? null
  const springFolder =
    dropFolder !== null && dropFolder !== ROOT_FOLDER && !tree.expanded.has(dropFolder) ? dropFolder : null
  useEffect(() => {
    if (springFolder === null) return
    const timer = setTimeout(() => expand(root, springFolder), SPRING_OPEN_MS)
    return () => clearTimeout(timer)
  }, [expand, root, springFolder])

  const selectedRow = rows[selectedIndex]
  const selectedEntry = selectedRow?.kind === "entry" ? selectedRow.entry : undefined
  const openedEntry =
    tree.opened === null ? undefined : tree.children[parentOf(tree.opened)]?.find((entry) => entry.path === tree.opened)
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

  const showChanges = (entry: FsEntry) => {
    useUi.getState().setChangesPath(entry.path)
    useUi.getState().showView(thread.id, "changes")
  }

  const startCreate = (entryKind: NewEntryKind) => {
    const parent =
      selectedEntry === undefined
        ? ""
        : selectedEntry.kind === "dir"
          ? selectedEntry.path
          : parentOf(selectedEntry.path)
    startNaming(root, { kind: "create", parent, entryKind })
  }

  const askToDelete = (entry: FsEntry | null) => startTransition(() => setDeleting(entry))

  const confirmDelete = (entry: FsEntry) => {
    askToDelete(null)
    void useExplorer
      .getState()
      .remove(root, entry.path)
      .catch(toastError)
      .then(() => treeRef.current?.focus())
  }

  const moveEntry = (path: string, folder: string) => {
    const origin = parentOf(path)
    const { move } = useExplorer.getState()
    move(root, path, folder)
      .then((moved) => {
        treeRef.current?.focus()
        toast(m.explorer_moved({ name: nameOf(moved), folder: folder === ROOT_FOLDER ? rootName : folder }), {
          position: "bottom-right",
          action: { label: m.common_undo(), onClick: () => void move(root, moved, origin).catch(toastError) },
        })
      })
      .catch(toastError)
  }

  const dragOverFolder = (event: DragEvent, folder: string) => {
    if (drag === null) return
    event.stopPropagation()
    const over = canMoveInto(drag.source, folder) ? folder : null
    if (over !== null) {
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
    }
    if (over !== drag.over) setDrag({ ...drag, over })
  }

  const dropInFolder = (event: DragEvent, folder: string) => {
    if (drag === null) return
    event.preventDefault()
    event.stopPropagation()
    setDrag(null)
    moveEntry(drag.source, folder)
  }

  const dragLeaveTree = (event: DragEvent<HTMLDivElement>) => {
    if (drag === null || event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDrag({ ...drag, over: null })
  }

  const moveTo = (index: number) => {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))]
    if (row?.kind === "entry") select(root, row.entry.path)
  }

  const jump = (key: string) => {
    const now = performance.now()
    const state = typeahead.current
    state.text = now - state.at > TYPEAHEAD_RESET_MS ? key.toLowerCase() : state.text + key.toLowerCase()
    state.at = now
    const start = state.text.length === 1 ? selectedIndex + 1 : Math.max(selectedIndex, 0)
    for (let offset = 0; offset < rows.length; offset++) {
      const row = rows[(start + offset) % rows.length]
      if (row?.kind === "entry" && row.entry.name.toLowerCase().startsWith(state.text)) {
        return select(root, row.entry.path)
      }
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return
    const current = rows[selectedIndex]
    const entry = selectedEntry
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
        event.stopPropagation()
        break
      case "F2":
        if (entry) startNaming(root, { kind: "rename", path: entry.path })
        break
      case "Delete":
        if (entry) askToDelete(entry)
        break
      case "Backspace":
        if (!event.metaKey || !entry) return
        askToDelete(entry)
        break
      default:
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
        jump(event.key)
    }
    event.preventDefault()
  }

  const onFocus = () => {
    const [first] = rows
    if (selectedIndex === -1 && first?.kind === "entry") select(root, first.entry.path)
  }

  const onRowClick = (entry: FsEntry) => {
    select(root, entry.path)
    treeRef.current?.focus()
    open(entry)
  }

  const isInDropFolder = (row: TreeRow | undefined) =>
    row?.kind === "entry" && dropFolder !== null && dropFolder !== ROOT_FOLDER && isWithin(row.entry.path, dropFolder)

  const siblingNames = (parent: string) => (tree.children[parent] ?? []).map((sibling) => sibling.name)

  const renderItem = ({ item, index }: { item: TreeRow; index: number }) => {
    if (item.kind === "draft") {
      return (
        <DraftItem depth={item.depth} entryKind={item.entryKind}>
          <NameInput
            label={item.entryKind === "dir" ? m.explorer_new_folder_name() : m.explorer_new_file_name()}
            initial=""
            taken={siblingNames(item.parent)}
            onSubmit={(name) => useExplorer.getState().create(root, item.parent, item.entryKind, name)}
            onCancel={() => startNaming(root, null)}
          />
        </DraftItem>
      )
    }
    const { entry } = item
    const renaming = tree.naming?.kind === "rename" && tree.naming.path === entry.path
    return (
      <TreeItem
        row={item}
        id={`${rowId}${index}`}
        selected={index === selectedIndex}
        expanded={tree.expanded.has(entry.path)}
        unsaved={entry.path in tree.unsaved}
        draggable={!renaming}
        dragged={drag !== null && isWithin(entry.path, drag.source)}
        dropEdges={
          isInDropFolder(item)
            ? { top: !isInDropFolder(rows[index - 1]), bottom: !isInDropFolder(rows[index + 1]) }
            : null
        }
        onClick={onRowClick}
        onContextMenu={(clicked) => select(root, clicked.path)}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move"
          event.dataTransfer.setData(ENTRY_DRAG_TYPE, entry.path)
          setDrag({ source: entry.path, over: null })
        }}
        onDragOver={(event) => dragOverFolder(event, dropFolderOf(entry))}
        onDrop={(event) => dropInFolder(event, dropFolderOf(entry))}
      >
        {renaming ? (
          <NameInput
            label={m.explorer_rename_label({ name: entry.name })}
            initial={entry.name}
            taken={siblingNames(parentOf(entry.path))}
            onSubmit={(name) => useExplorer.getState().rename(root, entry.path, name)}
            onCancel={() => startNaming(root, null)}
          />
        ) : undefined}
      </TreeItem>
    )
  }

  const listed = tree.children[""]

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={root}>
          {rootName}
        </span>
        <HeaderButton label={m.explorer_new_file()} action={() => startCreate("file")} icon={FileAddIcon} />
        <HeaderButton label={m.explorer_new_folder()} action={() => startCreate("dir")} icon={FolderAddIcon} />
        <HeaderButton label={m.explorer_collapse_all()} action={() => collapseAll(root)} icon={CollapseIcon} />
        {canReveal && (
          <HeaderButton
            label={m.panel_reveal()}
            action={() => callPromise("shell.reveal", { path: root }).catch(toastError)}
            icon={FolderOpenIcon}
          />
        )}
        <HeaderButton label={m.explorer_refresh()} action={() => refresh(root)} icon={RefreshIcon} />
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
        ) : listed.length === 0 && tree.naming === null ? (
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
                  onDragOver={(event) => dragOverFolder(event, ROOT_FOLDER)}
                  onDrop={(event) => dropInFolder(event, ROOT_FOLDER)}
                  onDragLeave={dragLeaveTree}
                  onDragEnd={() => setDrag(null)}
                  className={cn(
                    "group/tree flex min-h-0 flex-1 flex-col py-1 outline-none",
                    dropFolder === ROOT_FOLDER && "bg-primary/10",
                  )}
                />
              }
            >
              <LegendList
                ref={listRef}
                data={rows}
                keyExtractor={(row) => (row.kind === "entry" ? row.entry.path : `\0draft:${row.parent}`)}
                renderItem={renderItem}
                extraData={[tree, drag]}
                estimatedItemSize={ROW_HEIGHT}
                getFixedItemSize={() => ROW_HEIGHT}
                className="min-h-0 flex-1"
              />
            </ContextMenuTrigger>
            {selectedEntry && (
              <ContextMenuContent>
                <DropdownMenuItem onClick={() => startCreate("file")}>
                  <FileAddIcon aria-hidden />
                  {m.explorer_new_file()}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => startCreate("dir")}>
                  <FolderAddIcon aria-hidden />
                  {m.explorer_new_folder()}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => mention(selectedEntry)}>
                  <AtIcon aria-hidden />
                  {m.explorer_mention()}
                </DropdownMenuItem>
                {hasDiff(selectedEntry) && (
                  <DropdownMenuItem onClick={() => showChanges(selectedEntry)}>
                    <FileDiffIcon aria-hidden />
                    {m.explorer_show_changes()}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => void navigator.clipboard.writeText(selectedEntry.path).catch(toastError)}
                >
                  <CopyIcon aria-hidden />
                  {m.explorer_copy_path()}
                </DropdownMenuItem>
                {canReveal && (
                  <OpenWithSubmenu
                    path={`${root}/${selectedEntry.path}`}
                    target={selectedEntry.kind === "dir" ? "folder" : "file"}
                  />
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => startNaming(root, { kind: "rename", path: selectedEntry.path })}>
                  <PencilIcon aria-hidden />
                  {m.explorer_rename()}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => askToDelete(selectedEntry)}>
                  <TrashIcon aria-hidden />
                  {m.explorer_delete()}
                </DropdownMenuItem>
              </ContextMenuContent>
            )}
          </ContextMenu>
        )}
      </div>
      {tree.opened !== null && (
        <>
          <SplitHandle height={treeHeight} onResize={setTreeHeight} container={containerRef} />
          <HighlightWorkerPool>
            <FileViewer
              threadId={thread.id}
              root={root}
              path={tree.opened}
              onClose={closeFile}
              onShowChanges={openedEntry && hasDiff(openedEntry) ? () => showChanges(openedEntry) : undefined}
            />
          </HighlightWorkerPool>
        </>
      )}
      <DeleteEntryDialog entry={deleting} onCancel={() => askToDelete(null)} onDelete={confirmDelete} />
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}

function HeaderButton({
  label,
  icon: Icon,
  action,
}: {
  label: string
  icon: IconComponent
  action: () => void | Promise<void>
}) {
  return (
    <Button variant="ghost" size="icon-xs" aria-label={label} title={label} action={action}>
      <Icon aria-hidden />
    </Button>
  )
}

interface SplitHandleProps {
  readonly height: number
  readonly onResize: (height: number) => void
  readonly container: RefObject<HTMLDivElement | null>
}

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
  readonly row: Extract<TreeRow, { kind: "entry" }>
  readonly id: string
  readonly selected: boolean
  readonly expanded: boolean
  readonly unsaved: boolean
  readonly draggable: boolean
  readonly dragged: boolean
  readonly dropEdges: DropEdges | null
  readonly onClick: (entry: FsEntry) => void
  readonly onContextMenu: (entry: FsEntry) => void
  readonly onDragStart: (event: DragEvent) => void
  readonly onDragOver: (event: DragEvent) => void
  readonly onDrop: (event: DragEvent) => void
  readonly children?: ReactNode
}

function TreeItem({
  row,
  id,
  selected,
  expanded,
  unsaved,
  draggable,
  dragged,
  dropEdges,
  onClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  children,
}: TreeItemProps) {
  const { entry, depth } = row
  const isDir = entry.kind === "dir"
  const mark = entry.gitStatus === null ? null : fileStatusMark[entry.gitStatus]
  const description = [unsaved && m.viewer_unsaved(), mark?.label(), entry.ignored && m.explorer_ignored()]
    .filter(Boolean)
    .join(", ")

  return (
    <div
      id={id}
      role="treeitem"
      data-drop-target={dropEdges !== null}
      aria-level={depth + 1}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-selected={selected}
      aria-expanded={isDir ? expanded : undefined}
      aria-describedby={description ? `${id}-status` : undefined}
      onClick={() => onClick(entry)}
      onContextMenu={() => onContextMenu(entry)}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{ height: ROW_HEIGHT, paddingLeft: 8 + depth * INDENT }}
      className={cn(
        "relative mx-1 flex cursor-default items-center gap-1 rounded-md pr-2 text-[0.8125rem] select-none hover:bg-muted/60 aria-selected:bg-muted group-focus/tree:aria-selected:ring-1 group-focus/tree:aria-selected:ring-ring group-focus/tree:aria-selected:ring-inset",
        dragged && "opacity-50",
        dropEdges && "rounded-none bg-primary/10 hover:bg-primary/10 aria-selected:bg-primary/10",
        dropEdges?.top && "rounded-t-md",
        dropEdges?.bottom && "rounded-b-md",
      )}
    >
      <IndentGuides depth={depth} />
      <ChevronRightIcon
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
      {children ?? (
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            entry.ignored && "text-ignored-foreground",
            mark?.className,
            entry.kind === "symlink" && "italic",
          )}
        >
          {entry.name}
        </span>
      )}
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

function IndentGuides({ depth }: { depth: number }) {
  return Array.from({ length: depth }, (_, level) => (
    <span
      key={level}
      aria-hidden
      className="absolute inset-y-0 w-px bg-border"
      style={{ left: 8 + level * INDENT + 7 }}
    />
  ))
}

function DraftItem({ depth, entryKind, children }: { depth: number; entryKind: NewEntryKind; children: ReactNode }) {
  const Icon = entryKind === "dir" ? FolderIcon : FileIcon
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={false}
      style={{ height: ROW_HEIGHT, paddingLeft: 8 + depth * INDENT }}
      className="relative mx-1 flex items-center gap-1 pr-2 text-[0.8125rem]"
    >
      <IndentGuides depth={depth} />
      <ChevronRightIcon aria-hidden className="invisible size-3.5 shrink-0" />
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {children}
    </div>
  )
}

const nameProblem = (name: string, initial: string, taken: ReadonlyArray<string>) => {
  if (name.includes("/")) return m.explorer_name_slash()
  if (name === "." || name === "..") return m.explorer_name_invalid({ name })
  if (name !== initial && taken.includes(name)) return m.explorer_name_exists({ name })
  return null
}

interface NameInputProps {
  readonly label: string
  readonly initial: string
  readonly taken: ReadonlyArray<string>
  readonly onSubmit: (name: string) => Promise<void>
  readonly onCancel: () => void
}

function NameInput({ label, initial, taken, onSubmit, onCancel }: NameInputProps) {
  const [name, setName] = useState(initial)
  const [isPending, startSubmit] = useTransition()
  const settled = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const trimmed = name.trim()
  const problem = nameProblem(trimmed, initial, taken)

  useEffect(() => {
    const dot = initial.lastIndexOf(".")
    inputRef.current?.focus()
    inputRef.current?.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])

  const finish = (input: HTMLInputElement, returnFocus: boolean) => {
    const tree = returnFocus ? input.closest<HTMLElement>("[role=tree]") : null
    settled.current = true
    if (trimmed === "" || trimmed === initial) {
      onCancel()
      tree?.focus()
      return
    }
    startSubmit(async () => {
      try {
        await onSubmit(trimmed)
        tree?.focus()
      } catch (cause) {
        settled.current = false
        toastError(cause)
      }
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing) return
    if (event.key === "Escape") {
      settled.current = true
      onCancel()
      event.currentTarget.closest<HTMLElement>("[role=tree]")?.focus()
    } else if (event.key === "Enter" && problem === null && !isPending) {
      finish(event.currentTarget, true)
    }
  }

  const onBlur = (event: FocusEvent<HTMLInputElement>) => {
    if (settled.current) return
    if (problem === null) finish(event.currentTarget, false)
    else onCancel()
  }

  return (
    <Tooltip open={problem !== null}>
      <TooltipTrigger
        render={
          <input
            ref={inputRef}
            aria-label={label}
            aria-invalid={problem !== null}
            aria-describedby={problem === null ? undefined : errorId}
            value={name}
            readOnly={isPending}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onClick={(event) => event.stopPropagation()}
            className="h-5 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1 text-[0.8125rem] outline-none aria-invalid:border-destructive"
          />
        }
      />
      <TooltipContent id={errorId} role="alert" side="bottom" align="start">
        {problem}
      </TooltipContent>
    </Tooltip>
  )
}
