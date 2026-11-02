import type { IndicatorTone } from "@shared/threadStatus.ts"
import { Platform } from "react-native"
import type { IconName } from "@/components/icon"

export const Colors = {
  light: {
    text: "#233737",
    /** A thread row at rest, a step below a row that needs the developer. */
    textResting: "#3e5151",
    textMuted: "#556767",
    background: "#f7f7f2",
    surface: "#e8e8e0",
    surfaceStrong: "#d0d0c6",
    /** A switch's off track, 3:1 on `surface` and `background` so the control reads when it is off. */
    controlOff: "#738484",
    /** A sheet over the scrim, and a selected or pressed row on it. Dark sheets sit a step above the page. */
    sheet: "#f7f7f2",
    sheetRaised: "#e8e8e0",
    border: "#e0e0d7",
    primary: "#c0482c",
    onPrimary: "#f7f7f2",
    attention: "#8a5600",
    attentionBg: "#f8eaca",
    running: "#027271",
    runningBg: "#d6f2ef",
    danger: "#bd1f3d",
    dangerBg: "#fde2e2",
    neutralBg: "#e8e8e0",
    link: "#a73920",
    /** GitHub's open and merged pull request colors, the desktop's `--pr-open` and `--pr-merged`. */
    prOpen: "#1a7f37",
    prMerged: "#8250df",
    /** Skills, commands and mentions in the composer, as the desktop's `--syntax-token`. */
    token: "#a73920",
    tokenBg: "rgba(192, 72, 44, 0.12)",
    /** The send button's halo, the desktop's `send-halo` in the Hina themes. */
    haloA: "#c0482c",
    haloB: "#c37b00",
    haloC: "#921950",
    haloD: "#c0482c",
    haloCore: "#c0482c",
    haloInk: "#f7f7f2",
  },
  dark: {
    text: "#f7f7f2",
    textResting: "#d8d8d1",
    textMuted: "#b8b8ae",
    background: "#1c2e2e",
    surface: "#233737",
    surfaceStrong: "#324949",
    controlOff: "#758b8b",
    sheet: "#233737",
    sheetRaised: "#324949",
    border: "#324949",
    primary: "#e56b4f",
    onPrimary: "#0e1e1e",
    attention: "#f1c45e",
    attentionBg: "#463518",
    running: "#50b0ae",
    runningBg: "#0e3e3a",
    danger: "#f4839a",
    dangerBg: "#4d292f",
    neutralBg: "#324949",
    link: "#f48f70",
    prOpen: "#3fb950",
    prMerged: "#a371f7",
    token: "#f48f70",
    tokenBg: "rgba(229, 107, 79, 0.16)",
    haloA: "#e56b4f",
    haloB: "#e79d00",
    haloC: "#b6406f",
    haloD: "#e56b4f",
    haloCore: "#e56b4f",
    haloInk: "#0e1e1e",
  },
} as const

export type Palette = { readonly [K in keyof typeof Colors.light]: string }

const toneColor = (theme: Palette): Record<IndicatorTone, string> => ({
  muted: theme.textMuted,
  attention: theme.attention,
  // The desktop's `--success` is the phone's `running`.
  success: theme.running,
  danger: theme.danger,
  prOpen: theme.prOpen,
  prMerged: theme.prMerged,
})

/** An indicator from `@shared/threadStatus.ts` as an icon in this theme's color. */
export const indicatorGlyph = (theme: Palette, { icon, tone }: { icon: IconName; tone: IndicatorTone }) => ({
  name: icon,
  color: toneColor(theme)[tone],
})

/**
 * Each agent's mark in its brand color, as in the desktop's `--provider-*` tokens. Codex and opencode take the text
 * color.
 */
export const ProviderColors = {
  light: { claude: "#c15f3c", codex: Colors.light.text, muse: "#0064e0", opencode: Colors.light.text },
  dark: { claude: "#d97757", codex: Colors.dark.text, muse: "#0081fb", opencode: Colors.dark.text },
} as const

/**
 * Code colors per syntax class, from GitHub's light and dark themes. Each reads at 4.5:1 or more on `surface`,
 * the code block background. Operators share the keyword color, as on GitHub.
 */
export const SyntaxColors = {
  light: {
    plain: Colors.light.text,
    comment: "#57606a",
    string: "#0a3069",
    number: "#0550ae",
    constant: "#0550ae",
    keyword: "#c11e2b",
    operator: "#c11e2b",
    type: "#953800",
    function: "#6639ba",
  },
  dark: {
    plain: Colors.dark.text,
    comment: "#9ea7b3",
    string: "#a5d6ff",
    number: "#79c0ff",
    constant: "#79c0ff",
    keyword: "#ff7b72",
    operator: "#ff7b72",
    type: "#ffa657",
    function: "#d2a8ff",
  },
} as const

export const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" })

/** Minimum touch target. */
export const HIT = 44

/** A status pill's height, for rows that keep its place while it is hidden. */
export const PILL_HEIGHT = 20

/** Section headings sit under the screen title, which is the only level-1 heading. */
export const subheading = { "aria-level": 2 } as object

/** The widest a column of prose gets on a tablet, so lines stay readable. Every phone is narrower. */
export const READABLE_WIDTH = 720

/** Outer radius = inner radius + padding, so nested corners stay concentric. */
export const radius = { sm: 6, md: 10, lg: 14, xl: 24, full: 999 } as const
