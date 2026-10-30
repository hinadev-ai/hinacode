export interface SizeBounds {
  readonly min: number
  readonly max: number
}

export const SIDEBAR_BOUNDS: SizeBounds = { min: 200, max: 480 }
export const SIDEBAR_DEFAULT_WIDTH = 256
export const SIDE_PANEL_BOUNDS: SizeBounds = { min: 280, max: 960 }
export const TERMINAL_HEIGHT_BOUNDS: SizeBounds = { min: 120, max: Number.POSITIVE_INFINITY }
export const FILE_TREE_HEIGHT_BOUNDS: SizeBounds = { min: 96, max: Number.POSITIVE_INFINITY }
export const GIT_GRAPH_SPLIT_BOUNDS: SizeBounds = { min: 20, max: 80 }

export const clampSize = ({ min, max }: SizeBounds, size: number) => Math.round(Math.min(max, Math.max(min, size)))

export function loadSize(key: string, bounds: SizeBounds) {
  const stored = Number.parseFloat(localStorage.getItem(key) ?? "")
  return Number.isFinite(stored) ? clampSize(bounds, stored) : null
}

export const saveSize = (key: string, size: number | null) =>
  size === null ? localStorage.removeItem(key) : localStorage.setItem(key, String(size))
