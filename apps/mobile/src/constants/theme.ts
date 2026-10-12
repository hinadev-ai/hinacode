import { Platform } from "react-native"

export const Colors = {
  light: {
    text: "#0a0a0a",
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
  },
  dark: {
    text: "#fafafa",
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
  },
} as const

export type Palette = { readonly [K in keyof typeof Colors.light]: string }

export const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" })

/** Minimum touch target. */
export const HIT = 44
