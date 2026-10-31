import type { DiffsThemeNames } from "@pierre/diffs"
import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { useSyncExternalStore } from "react"
import type { Appearance, ThemeId } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"

interface Theme {
  readonly label: () => string
  readonly scheme: "dark" | "light" | "system"
  readonly codeTheme?: DiffsThemeNames
}

export const themes: Record<ThemeId, Theme> = {
  system: { label: m.theme_system, scheme: "system" },
  light: { label: m.theme_light, scheme: "light" },
  default: { label: m.theme_default, scheme: "dark" },
  "catppuccin-mocha": { label: () => "Catppuccin Mocha", scheme: "dark", codeTheme: "catppuccin-mocha" },
  "catppuccin-latte": { label: () => "Catppuccin Latte", scheme: "light", codeTheme: "catppuccin-latte" },
  "tokyo-night": { label: () => "Tokyo Night", scheme: "dark", codeTheme: "tokyo-night" },
  "rose-pine": { label: () => "Rosé Pine", scheme: "dark", codeTheme: "rose-pine" },
  "gruvbox-dark": { label: () => "Gruvbox Dark", scheme: "dark", codeTheme: "gruvbox-dark-medium" },
  "github-dark": { label: () => "GitHub Dark", scheme: "dark", codeTheme: "github-dark" },
  "github-light": { label: () => "GitHub Light", scheme: "light", codeTheme: "github-light" },
  "one-dark-pro": { label: () => "One Dark Pro", scheme: "dark", codeTheme: "one-dark-pro" },
  dracula: { label: () => "Dracula", scheme: "dark", codeTheme: "dracula" },
  "material-theme": { label: () => "Material Theme", scheme: "dark", codeTheme: "material-theme" },
  pinky: { label: () => "Pinky", scheme: "light", codeTheme: "rose-pine-dawn" },
  "hina-light": { label: m.theme_hina_light, scheme: "light", codeTheme: "vitesse-light" },
  "hina-dark": { label: m.theme_hina_dark, scheme: "dark", codeTheme: "vitesse-dark" },
}

const systemAppearance = window.matchMedia("(prefers-color-scheme: dark)")
const appearanceListeners = new Set<() => void>()
systemAppearance.addEventListener("change", () => {
  for (const listener of appearanceListeners) listener()
})

const subscribeAppearance = (listener: () => void) => {
  appearanceListeners.add(listener)
  return () => {
    appearanceListeners.delete(listener)
  }
}

const resolveScheme = (theme: ThemeId): "dark" | "light" => {
  const scheme = themes[theme].scheme
  if (scheme !== "system") return scheme
  return systemAppearance.matches ? "dark" : "light"
}

export function useTheme(theme: ThemeId) {
  const scheme = useSyncExternalStore(subscribeAppearance, () => resolveScheme(theme))
  return { ...themes[theme], scheme }
}

const fontFamily = (name: string | null) => (name === null ? "" : JSON.stringify(name))

export function applyAppearance(
  { theme, fontSize, uiFont, monoFont, contrast }: Appearance,
  scheme: "dark" | "light" = resolveScheme(theme),
) {
  const root = document.documentElement
  root.classList.toggle("dark", scheme === "dark")
  root.style.colorScheme = scheme
  if (theme === "default" || theme === "system" || theme === "light") delete root.dataset.theme
  else root.dataset.theme = theme
  root.style.fontSize = `${fontSize}px`
  root.style.setProperty("--ui-font", fontFamily(uiFont))
  root.style.setProperty("--mono-font", fontFamily(monoFont))
  applyContrast(contrast)
}

export function applyContrast(contrast: number) {
  document.documentElement.style.setProperty("--contrast", String(contrast / 100))
}

declare global {
  interface Window {
    queryLocalFonts(): Promise<ReadonlyArray<{ readonly family: string }>>
  }
}

export interface InstalledFonts {
  readonly all: ReadonlyArray<string>
  readonly monospace: ReadonlyArray<string>
}

export async function listInstalledFonts(): Promise<InstalledFonts> {
  const faces = await window.queryLocalFonts()
  const all = [...new Set(faces.map((face) => face.family))].toSorted((a, b) => a.localeCompare(b))
  const context = new OffscreenCanvas(1, 1).getContext("2d")
  if (!context) return { all, monospace: [] }
  const isMonospace = (family: string) => {
    context.font = `16px ${JSON.stringify(family)}`
    return context.measureText("iiiiii").width === context.measureText("MMMMMM").width
  }
  return { all, monospace: all.filter(isMonospace) }
}

export const installedFontsAtom = Atom.make(Effect.tryPromise(listInstalledFonts)).pipe(Atom.keepAlive)
