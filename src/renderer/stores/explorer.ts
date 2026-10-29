import { create } from "zustand"
import type { FsEntry } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"

export interface ExplorerTree {
  readonly expanded: ReadonlySet<string>
  readonly children: Readonly<Record<string, ReadonlyArray<FsEntry>>>
  readonly selected: string | null
  readonly opened: string | null
  readonly error: string | null
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
  readonly depth: number
  readonly setSize: number
  readonly posInSet: number
}

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

const forget = (tree: ExplorerTree, path: string) => {
  const expanded = new Set(tree.expanded)
  expanded.delete(path)
  const { [path]: _gone, ...children } = tree.children
  return { expanded, children }
}

interface ExplorerState {
  readonly byRoot: Readonly<Record<string, ExplorerTree>>
  readonly load: (root: string, path: string) => Promise<void>
  readonly refresh: (root: string) => Promise<void>
  readonly expand: (root: string, path: string) => void
  readonly collapse: (root: string, path: string) => void
  readonly collapseAll: (root: string) => void
  readonly select: (root: string, path: string | null) => void
  readonly open: (root: string, path: string | null) => void
  readonly reveal: (root: string, path: string) => void
  readonly setUnsaved: (root: string, path: string, base: string | null) => void
}

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
    reveal: (root, path) => {
      const folders = path
        .split("/")
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join("/"))
      update(root, (tree) => ({ expanded: new Set([...tree.expanded, ...folders]), selected: path, opened: path }))
      for (const folder of folders) void get().load(root, folder)
    },
    setUnsaved: (root, path, base) =>
      update(root, (tree) => {
        const { [path]: _previous, ...unsaved } = tree.unsaved
        return { unsaved: base === null ? unsaved : { ...unsaved, [path]: base } }
      }),
  }
})
