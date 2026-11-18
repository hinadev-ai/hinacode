import { useSyncExternalStore } from "react"
import { SIDE_PANEL_BOUNDS } from "./panelSize.ts"

const MIN_MESSAGE_WIDTH = 200
const COMPOSER_PADDING_REM = 2.75
const ACTIVITY_BAR_WIDTH_REM = 2.75

export const CONTENT_MIN_WIDTH = `calc(${MIN_MESSAGE_WIDTH}px + ${COMPOSER_PADDING_REM}rem + 3px)`

const rootFontSize = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
const panelSpace = (fontSize: number) =>
  (document.querySelector("main")?.getBoundingClientRect().width ?? window.innerWidth) -
  MIN_MESSAGE_WIDTH -
  (COMPOSER_PADDING_REM + ACTIVITY_BAR_WIDTH_REM) * fontSize -
  3

export function getPanelLayout() {
  const fontSize = rootFontSize()
  const width = window.innerWidth / fontSize
  if (width >= 72 && panelSpace(fontSize) >= SIDE_PANEL_BOUNDS.min) return "wide"
  if (width >= 48) return "sidebar"
  return "compact"
}

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
