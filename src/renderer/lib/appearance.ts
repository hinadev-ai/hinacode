import type { DiffsThemeNames } from "@pierre/diffs"
import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { useSyncExternalStore } from "react"
import type { Appearance, ThemeId } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"

interface Theme {
  readonly label: () => string
  readonly scheme: "dark" | "light" | "system"
  /** Shiki theme for syntax highlighting in diffs. Undefined keeps the diff viewer's own theme. */
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

/** Sets text contrast on its own, so a slider can preview it before the setting is saved. */
export function applyContrast(contrast: number) {
  document.documentElement.style.setProperty("--contrast", String(contrast / 100))
}

/** Resolves a color custom property on the root to hex, for libraries that cannot read CSS variables or oklch. */
export function resolveColor(variable: string): string {
  const canvas = new OffscreenCanvas(1, 1)
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) throw new Error("2D canvas is unavailable")
  const style = getComputedStyle(document.documentElement)
  // Painting over the background flattens translucent tokens such as the default dark border.
  context.fillStyle = style.getPropertyValue("--background")
  context.fillRect(0, 0, 1, 1)
  context.fillStyle = style.getPropertyValue(variable)
  context.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

declare global {
  interface Window {
    /** Local Font Access API. Electron grants its permission because hinacode installs no permission handler. */
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
