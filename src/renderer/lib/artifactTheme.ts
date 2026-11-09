import { useEffect, useSyncExternalStore } from "react"
import { type ArtifactTheme, THEME_TOKENS } from "../../shared/artifactTheme.ts"
import { callPromise } from "./rpc.ts"

const subscribe = (listener: () => void) => {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] })
  return () => observer.disconnect()
}

const currentTheme = (): ArtifactTheme => {
  const style = getComputedStyle(document.documentElement)
  return {
    scheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    tokens: Object.fromEntries(
      THEME_TOKENS.map((token) => [token, style.getPropertyValue(token).trim()]),
    ) as ArtifactTheme["tokens"],
  }
}

const readTheme = () => JSON.stringify(currentTheme())

export const useArtifactTheme = () => useSyncExternalStore(subscribe, readTheme)

const shareTheme = () => {
  callPromise("artifacts.setTheme", currentTheme()).catch(() => undefined)
}

export function useShareArtifactTheme() {
  useEffect(() => {
    shareTheme()
    return subscribe(shareTheme)
  }, [])
}
