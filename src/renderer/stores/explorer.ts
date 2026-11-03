import { create } from "zustand"
import type { FsEntry, FsEntryKind } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"

export type NewEntryKind = Exclude<FsEntryKind, "symlink">

export type Naming =
  | { readonly kind: "create"; readonly parent: string; readonly entryKind: NewEntryKind }
  | { readonly kind: "rename"; readonly path: string }

export interface ExplorerTree {
  readonly expanded: ReadonlySet<string>
  readonly children: Readonly<Record<string, ReadonlyArray<FsEntry>>>
  readonly selected: string | null
  readonly opened: string | null
  readonly error: string | null
  readonly unsaved: Readonly<Record<string, string>>
  readonly naming: Naming | null
}

export const emptyTree: ExplorerTree = {
  expanded: new Set(),
  children: {},
  selected: null,
  opened: null,
  error: null,
  unsaved: {},
  naming: null,
}

export type TreeRow =
  | {
      readonly kind: "entry"
      readonly entry: FsEntry
      readonly depth: number
      readonly setSize: number
      readonly posInSet: number
    }
  | { readonly kind: "draft"; readonly parent: string; readonly entryKind: NewEntryKind; readonly depth: number }

export function flattenTree(tree: Pick<ExplorerTree, "expanded" | "children" | "naming">): Array<TreeRow> {
  const rows: Array<TreeRow> = []
  const walk = (folder: string, depth: number) => {
    if (tree.naming?.kind === "create" && tree.naming.parent === folder) {
      rows.push({ kind: "draft", parent: folder, entryKind: tree.naming.entryKind, depth })
    }
    const entries = tree.children[folder] ?? []
    entries.forEach((entry, index) => {
      rows.push({ kind: "entry", entry, depth, setSize: entries.length, posInSet: index + 1 })
      if (entry.kind === "dir" && tree.expanded.has(entry.path)) walk(entry.path, depth + 1)
    })
  }
  walk("", 0)
  return rows
}

export const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0))

export const childPath = (parent: string, name: string) => (parent === "" ? name : `${parent}/${name}`)

const isWithin = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)

const moved = (path: string, from: string, to: string) => (isWithin(path, from) ? to + path.slice(from.length) : path)

const withoutPaths = <A>(record: Readonly<Record<string, A>>, gone: string) =>
  Object.fromEntries(Object.entries(record).filter(([path]) => !isWithin(path, gone)))

export const afterRename = (tree: ExplorerTree, from: string, to: string): ExplorerTree => ({
  ...tree,
  naming: null,
  expanded: new Set([...tree.expanded].map((folder) => moved(folder, from, to))),
  children: withoutPaths(tree.children, from),
  unsaved: withoutPaths(tree.unsaved, from),
  selected: tree.selected === null ? null : moved(tree.selected, from, to),
  opened: tree.opened === null ? null : moved(tree.opened, from, to),
})

export const afterDelete = (tree: ExplorerTree, path: string): ExplorerTree => ({
  ...tree,
  expanded: new Set([...tree.expanded].filter((folder) => !isWithin(folder, path))),
  children: withoutPaths(tree.children, path),
  unsaved: withoutPaths(tree.unsaved, path),
  selected: tree.selected !== null && isWithin(tree.selected, path) ? parentOf(path) || null : tree.selected,
  opened: tree.opened !== null && isWithin(tree.opened, path) ? null : tree.opened,
})

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
  readonly startNaming: (root: string, naming: Naming | null) => void
  readonly create: (root: string, parent: string, kind: NewEntryKind, name: string) => Promise<void>
  readonly rename: (root: string, path: string, name: string) => Promise<void>
  readonly remove: (root: string, path: string) => Promise<void>
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
    startNaming: (root, naming) => {
      if (naming?.kind === "create" && naming.parent !== "") get().expand(root, naming.parent)
      update(root, () => ({ naming }))
    },
    create: async (root, parent, kind, name) => {
      const path = childPath(parent, name)
      await callPromise("fs.create", { root, path, kind })
      await get().load(root, parent)
      update(root, (tree) => ({ naming: null, selected: path, opened: kind === "file" ? path : tree.opened }))
    },
    rename: async (root, path, name) => {
      const to = childPath(parentOf(path), name)
      await callPromise("fs.rename", { root, from: path, to })
      update(root, (tree) => afterRename(tree, path, to))
      await get().refresh(root)
    },
    remove: async (root, path) => {
      await callPromise("fs.delete", { root, path })
      update(root, (tree) => afterDelete(tree, path))
      await get().load(root, parentOf(path))
    },
  }
})
