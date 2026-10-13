import { create } from "zustand"
import type { FsEntry } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"

/** The file tree of one root: a worktree or a project root. Folder paths are relative, "" is the root. */
export interface ExplorerTree {
  readonly expanded: ReadonlySet<string>
  /** Listings by folder path, filled as folders are expanded. */
  readonly children: Readonly<Record<string, ReadonlyArray<FsEntry>>>
  readonly selected: string | null
  /** The file the viewer shows. */
  readonly opened: string | null
  /** Why the root itself could not be listed. */
  readonly error: string | null
  /** Files with unsaved edits, each mapped to the text the edits started from. */
  readonly unsaved: Readonly<Record<string, string>>
}

export const emptyTree: ExplorerTree = {
  expanded: new Set(),
  children: {},
  selected: null,
  opened: null,
  error: null,
  unsaved: {},
}

export interface TreeRow {
  readonly entry: FsEntry
  /** 0 for entries of the root. */
  readonly depth: number
  /** Siblings in the same folder and this entry's 1-based place among them, for `aria-setsize` and `aria-posinset`. */
  readonly setSize: number
  readonly posInSet: number
}

/** The rows a tree shows, top to bottom: every entry whose ancestors are all expanded and listed. */
export function flattenTree(tree: Pick<ExplorerTree, "expanded" | "children">): Array<TreeRow> {
  const rows: Array<TreeRow> = []
  const walk = (folder: string, depth: number) => {
    const entries = tree.children[folder] ?? []
    entries.forEach((entry, index) => {
      rows.push({ entry, depth, setSize: entries.length, posInSet: index + 1 })
      if (entry.kind === "dir" && tree.expanded.has(entry.path)) walk(entry.path, depth + 1)
    })
  }
  walk("", 0)
  return rows
}

export const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0))

/** Drops a folder that can no longer be listed. */
const forget = (tree: ExplorerTree, path: string) => {
  const expanded = new Set(tree.expanded)
  expanded.delete(path)
  const { [path]: _gone, ...children } = tree.children
  return { expanded, children }
}

interface ExplorerState {
  readonly byRoot: Readonly<Record<string, ExplorerTree>>
  /** Lists `path` again. A folder that can no longer be listed is collapsed and forgotten. */
  readonly load: (root: string, path: string) => Promise<void>
  /** Lists the root and every expanded folder again. */
  readonly refresh: (root: string) => Promise<void>
  readonly expand: (root: string, path: string) => void
  readonly collapse: (root: string, path: string) => void
  readonly collapseAll: (root: string) => void
  readonly select: (root: string, path: string | null) => void
  /** Shows `path` in the file viewer, or closes the viewer. */
  readonly open: (root: string, path: string | null) => void
  /** Marks `path` as edited since `base`, or as saved when `base` is null. */
  readonly setUnsaved: (root: string, path: string, base: string | null) => void
}

/** Kept per root for the whole session, so switching threads or tabs keeps what was open. */
export const useExplorer = create<ExplorerState>()((set, get) => {
  const update = (root: string, change: (tree: ExplorerTree) => Partial<ExplorerTree>) =>
    set((state) => {
      const tree = state.byRoot[root] ?? emptyTree
      return { byRoot: { ...state.byRoot, [root]: { ...tree, ...change(tree) } } }
    })

  return {
    byRoot: {},
    load: async (root, path) => {
      try {
        const entries = await callPromise("fs.list", { root, path })
        update(root, (tree) => ({
          children: { ...tree.children, [path]: entries },
          error: path === "" ? null : tree.error,
        }))
      } catch (cause) {
        update(root, (tree) => (path === "" ? { error: errorMessage(cause) } : forget(tree, path)))
      }
    },
    refresh: async (root) => {
      const tree = get().byRoot[root] ?? emptyTree
      await Promise.all(["", ...tree.expanded].map((path) => get().load(root, path)))
    },
    expand: (root, path) => {
      update(root, (tree) => ({ expanded: new Set(tree.expanded).add(path) }))
      void get().load(root, path)
    },
    collapse: (root, path) =>
      update(root, (tree) => {
        const expanded = new Set(tree.expanded)
        expanded.delete(path)
        return { expanded }
      }),
    collapseAll: (root) => update(root, () => ({ expanded: new Set() })),
    select: (root, selected) => update(root, () => ({ selected })),
    open: (root, opened) => update(root, () => ({ opened })),
    setUnsaved: (root, path, base) =>
      update(root, (tree) => {
        const { [path]: _previous, ...unsaved } = tree.unsaved
        return { unsaved: base === null ? unsaved : { ...unsaved, [path]: base } }
      }),
  }
})
