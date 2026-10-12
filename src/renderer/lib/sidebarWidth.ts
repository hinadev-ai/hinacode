export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 480
export const SIDEBAR_DEFAULT_WIDTH = 256

const STORAGE_KEY = "kkcode.sidebarWidth"

export const clampSidebarWidth = (width: number) =>
  Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)))

export function loadSidebarWidth() {
  const stored = Number.parseFloat(localStorage.getItem(STORAGE_KEY) ?? "")
  return Number.isFinite(stored) ? clampSidebarWidth(stored) : SIDEBAR_DEFAULT_WIDTH
}

export const saveSidebarWidth = (width: number) => localStorage.setItem(STORAGE_KEY, String(width))
