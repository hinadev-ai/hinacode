import { useSyncExternalStore } from "react"

export function getPanelLayout() {
  const width = window.innerWidth / Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  if (width >= 72) return "wide"
  if (width >= 48) return "sidebar"
  return "compact"
}

const subscribe = (onChange: () => void) => {
  window.addEventListener("resize", onChange)
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] })
  const resizeObserver = new ResizeObserver(onChange)
  resizeObserver.observe(document.documentElement)
  return () => {
    window.removeEventListener("resize", onChange)
    observer.disconnect()
    resizeObserver.disconnect()
  }
}

export const usePanelLayout = () => useSyncExternalStore(subscribe, getPanelLayout)
