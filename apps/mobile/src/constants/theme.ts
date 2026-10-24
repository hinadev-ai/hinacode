import { Platform } from "react-native"

export const Colors = {
  light: {
    text: "#0a0a0a",
    /** A thread row at rest, a step below a row that needs the developer. */
    textResting: "#3f3f46",
    textMuted: "#5c5c66",
    background: "#ffffff",
    surface: "#f4f4f5",
    surfaceStrong: "#e4e4e7",
    border: "#e4e4e7",
    primary: "#7c3aed",
    onPrimary: "#ffffff",
    attention: "#b45309",
    attentionBg: "#fef3c7",
    running: "#047857",
    runningBg: "#d1fae5",
    danger: "#b91c1c",
    dangerBg: "#fee2e2",
    neutralBg: "#f4f4f5",
    link: "#6d28d9",
    /** Skills, commands and mentions in the composer, as the desktop's `--syntax-token`. */
    token: "#7c3aed",
    tokenBg: "rgba(124, 58, 237, 0.12)",
  },
  dark: {
    text: "#fafafa",
    textResting: "#d4d4d8",
    textMuted: "#a1a1aa",
    background: "#0a0a0a",
    surface: "#18181b",
    surfaceStrong: "#27272a",
    border: "#27272a",
    primary: "#7c3aed",
    onPrimary: "#ffffff",
    attention: "#fbbf24",
    attentionBg: "#3a2a07",
    running: "#34d399",
    runningBg: "#06291f",
    danger: "#f87171",
    dangerBg: "#3b1111",
    neutralBg: "#27272a",
    link: "#a78bfa",
    token: "#a78bfa",
    tokenBg: "rgba(167, 139, 250, 0.16)",
  },
} as const

export type Palette = { readonly [K in keyof typeof Colors.light]: string }

/** Each agent's mark in its brand color, as in the desktop's `--provider-*` tokens. Codex takes the text color. */
export const ProviderColors = {
  light: { claude: "#c15f3c", codex: Colors.light.text, muse: "#0064e0" },
  dark: { claude: "#d97757", codex: Colors.dark.text, muse: "#0081fb" },
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
    keyword: "#cf222e",
    operator: "#cf222e",
    type: "#953800",
    function: "#6639ba",
  },
  dark: {
    plain: Colors.dark.text,
    comment: "#8b949e",
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

/** Outer radius = inner radius + padding, so nested corners stay concentric. */
export const radius = { sm: 6, md: 10, lg: 14, xl: 24, full: 999 } as const
