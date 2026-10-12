import { useSyncExternalStore } from "react"
import { SIDE_PANEL_BOUNDS } from "./panelWidth.ts"

// Leave a 200px message field after the form and composer-bar padding and borders.
const MIN_MESSAGE_WIDTH = 200
const COMPOSER_PADDING_REM = 2.75
const ACTIVITY_BAR_WIDTH_REM = 2.75

const rootFontSize = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
const panelSpace = (fontSize: number) =>
  (document.querySelector("main")?.getBoundingClientRect().width ?? window.innerWidth) -
  MIN_MESSAGE_WIDTH -
  (COMPOSER_PADDING_REM + ACTIVITY_BAR_WIDTH_REM) * fontSize -
  3 // Two composer borders and the docked panel's outer border.

export function getPanelLayout() {
  const fontSize = rootFontSize()
  const width = window.innerWidth / fontSize
  if (width >= 72 && panelSpace(fontSize) >= SIDE_PANEL_BOUNDS.min) return "wide"
  if (width >= 48) return "sidebar"
  return "compact"
}

/** Bounds the displayed panel without changing its saved normal or wide preference. */
export const getSidePanelMaxWidth = () =>
  Math.max(
    SIDE_PANEL_BOUNDS.min,
    Math.floor(Math.min(SIDE_PANEL_BOUNDS.max, window.innerWidth / 2, panelSpace(rootFontSize()))),
  )

const subscribe = (onChange: () => void) => {
  window.addEventListener("resize", onChange)
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] })
  const resizeObserver = new ResizeObserver(onChange)
  resizeObserver.observe(document.documentElement)
  const main = document.querySelector("main")
  if (main) resizeObserver.observe(main)
  return () => {
    window.removeEventListener("resize", onChange)
    observer.disconnect()
    resizeObserver.disconnect()
  }
}

export const usePanelLayout = () => useSyncExternalStore(subscribe, getPanelLayout)
export const useSidePanelMaxWidth = () => useSyncExternalStore(subscribe, getSidePanelMaxWidth)
