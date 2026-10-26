import type { SidebarGroup, SidebarGroups } from "../../shared/domain.ts"

export const createGroup = (state: SidebarGroups, group: SidebarGroup, rowKey: string): SidebarGroups => ({
  groups: [...state.groups, group],
  groupOf: { ...state.groupOf, [rowKey]: group.id },
})

const updateGroup = (state: SidebarGroups, id: string, patch: Partial<Omit<SidebarGroup, "id">>): SidebarGroups => ({
  ...state,
  groups: state.groups.map((group) => (group.id === id ? { ...group, ...patch } : group)),
})

export const renameGroup = (state: SidebarGroups, id: string, name: string) => updateGroup(state, id, { name })

export const setGroupCollapsed = (state: SidebarGroups, id: string, collapsed: boolean) =>
  updateGroup(state, id, { collapsed })

/** Swaps the group with its neighbor above (-1) or below (1). A move past either end changes nothing. */
export const moveGroup = (state: SidebarGroups, id: string, offset: -1 | 1): SidebarGroups => {
  const from = state.groups.findIndex((group) => group.id === id)
  const to = from + offset
  if (from === -1 || to < 0 || to >= state.groups.length) return state
  const groups = [...state.groups]
  groups.splice(to, 0, ...groups.splice(from, 1))
  return { ...state, groups }
}

/** Its projects go back to the ungrouped list. */
export const deleteGroup = (state: SidebarGroups, id: string): SidebarGroups => ({
  groups: state.groups.filter((group) => group.id !== id),
  groupOf: Object.fromEntries(Object.entries(state.groupOf).filter(([, groupId]) => groupId !== id)),
})

/** Moves a project row into a group, or out of every group for null. */
export const assignGroup = (state: SidebarGroups, rowKey: string, groupId: string | null): SidebarGroups => {
  const { [rowKey]: _previous, ...rest } = state.groupOf
  return { ...state, groupOf: groupId === null ? rest : { ...rest, [rowKey]: groupId } }
}

export interface ArrangedRows<Row> {
  /** Every group in order, empty ones included, each with its rows in the given order. */
  readonly grouped: ReadonlyArray<{ readonly group: SidebarGroup; readonly rows: ReadonlyArray<Row> }>
  readonly ungrouped: ReadonlyArray<Row>
}

/** Files rows under their groups. A row whose group no longer exists is ungrouped. */
export function arrangeRows<Row extends { readonly key: string }>(
  rows: ReadonlyArray<Row>,
  state: SidebarGroups,
): ArrangedRows<Row> {
  const ids = new Set(state.groups.map((group) => group.id))
  const groupIdOf = (row: Row) => {
    const id = state.groupOf[row.key]
    return id !== undefined && ids.has(id) ? id : undefined
  }
  return {
    grouped: state.groups.map((group) => ({ group, rows: rows.filter((row) => groupIdOf(row) === group.id) })),
    ungrouped: rows.filter((row) => groupIdOf(row) === undefined),
  }
}
