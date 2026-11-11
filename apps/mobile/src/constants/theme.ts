import type { CalloutTone } from "@shared/documentCallout.ts"
import type { IndicatorTone } from "@shared/threadStatus.ts"
import { Platform } from "react-native"
import type { IconName } from "@/components/icon"

export const Colors = {
  light: {
    text: "#233737",
    textResting: "#3e5151",
    textMuted: "#556767",
    background: "#f7f7f2",
    card: "#ffffff",
    surface: "#e8e8e0",
    surfaceStrong: "#d0d0c6",
    controlOff: "#738484",
    disabled: "#d0d0c6",
    inkWash: "rgba(35, 55, 55, 0.06)",
    sheet: "#f7f7f2",
    sheetRaised: "#e8e8e0",
    scrim: "rgba(10, 10, 10, 0.5)",
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
    prOpen: "#1a7f37",
    prMerged: "#8250df",
    token: "#a73920",
    tokenBg: "rgba(192, 72, 44, 0.12)",
    findMatch: "rgba(167, 57, 32, 0.22)",
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
    card: "#213434",
    surface: "#233737",
    surfaceStrong: "#324949",
    controlOff: "#758b8b",
    disabled: "#425b5b",
    inkWash: "rgba(247, 247, 242, 0.09)",
    sheet: "#233737",
    sheetRaised: "#324949",
    scrim: "rgba(0, 0, 0, 0.72)",
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
    findMatch: "rgba(244, 143, 112, 0.3)",
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
  foreground: theme.text,
  muted: theme.textMuted,
  attention: theme.attention,
  success: theme.running,
  danger: theme.danger,
  prOpen: theme.prOpen,
  prMerged: theme.prMerged,
})

export const indicatorGlyph = (theme: Palette, { icon, tone }: { icon: IconName; tone: IndicatorTone }) => ({
  name: icon,
  color: toneColor(theme)[tone],
})

export const ProviderColors = {
  light: { claude: "#c15f3c", codex: Colors.light.text, muse: "#0064e0", opencode: "#a16207", magpie: Colors.light.text },
  dark: { claude: "#d97757", codex: Colors.dark.text, muse: "#0081fb", opencode: "#eab308", magpie: Colors.dark.text },
} as const

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

export const CalloutColors = {
  light: {
    note: { ink: "#2a75ba", tint: "#e7edee", label: "#296393" },
    tip: { ink: "#008971", tint: "#e7eee7", label: "#1b7160" },
    important: { ink: "#794db6", tint: "#ece9ee", label: "#604991" },
    warning: { ink: "#973c00", tint: "#f1e8df", label: "#783e1f" },
    caution: { ink: "#bd1f3d", tint: "#f5e7e3", label: "#93333d" },
  },
  dark: {
    note: { ink: "#61a3e6", tint: "#263f48", label: "#8cbbeb" },
    tip: { ink: "#57b9a1", tint: "#25423f", label: "#89cbb7" },
    important: { ink: "#b897f0", tint: "#333e49", label: "#c9b2f2" },
    warning: { ink: "#ffb900", tint: "#3d4334", label: "#fecc6e" },
    caution: { ink: "#f4839a", tint: "#3e3c3e", label: "#f8a5b2" },
  },
} as const satisfies Record<"light" | "dark", Record<CalloutTone, { ink: string; tint: string; label: string }>>

export const ChartColors = {
  light: ["#2a75ba", "#008971", "#b75f0b", "#af467e", "#5d822f", "#717171"],
  dark: ["#61a3e6", "#57b9a1", "#e29d56", "#da7baa", "#92ba66", "#808080"],
} as const

// FIXME: some Android phones map the generic `monospace` family to a proportional font, so Android bundles one.
export const mono = Platform.select({ ios: "Menlo", android: "JetBrains Mono", default: "ui-monospace, Menlo, monospace" })

export const HIT = 44

export const PILL_HEIGHT = 20

export const subheading = { "aria-level": 2 } as object

export const READABLE_WIDTH = 720

export const radius = { sm: 6, md: 10, lg: 14, xl: 24, full: 999 } as const
