export interface WidthBounds {
  readonly min: number
  readonly max: number
}

export const SIDEBAR_BOUNDS: WidthBounds = { min: 200, max: 480 }
export const SIDEBAR_DEFAULT_WIDTH = 256
export const SIDE_PANEL_BOUNDS: WidthBounds = { min: 280, max: 960 }

export const clampWidth = ({ min, max }: WidthBounds, width: number) => Math.round(Math.min(max, Math.max(min, width)))

/** The width the user last gave a panel, or null when they never resized it. */
export function loadWidth(key: string, bounds: WidthBounds) {
  const stored = Number.parseFloat(localStorage.getItem(key) ?? "")
  return Number.isFinite(stored) ? clampWidth(bounds, stored) : null
}

export const saveWidth = (key: string, width: number | null) =>
  width === null ? localStorage.removeItem(key) : localStorage.setItem(key, String(width))
