import { type ArtifactTheme, THEME_TOKENS } from "../../shared/artifactTheme.ts"
import { useSyncExternalStore } from "react"

const subscribe = (listener: () => void) => {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] })
  return () => observer.disconnect()
}

const readTheme = () => {
  const style = getComputedStyle(document.documentElement)
  const theme: ArtifactTheme = {
    scheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    tokens: Object.fromEntries(
      THEME_TOKENS.map((token) => [token, style.getPropertyValue(token).trim()]),
    ) as ArtifactTheme["tokens"],
  }
  return JSON.stringify(theme)
}

export const useArtifactTheme = () => useSyncExternalStore(subscribe, readTheme)
