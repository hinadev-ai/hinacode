import { cubicBezier, Easing } from "react-native-reanimated"

/** The desktop's curves from `src/renderer/index.css`, for worklet animations. */
export const ease = {
  out: Easing.bezier(0.23, 1, 0.32, 1),
  inOut: Easing.bezier(0.77, 0, 0.175, 1),
  drawer: Easing.bezier(0.32, 0.72, 0, 1),
  swap: Easing.bezier(0.2, 0, 0, 1),
} as const

/** The same curves for Reanimated's CSS animations and transitions. */
export const cssEase = {
  out: cubicBezier(0.23, 1, 0.32, 1),
  drawer: cubicBezier(0.32, 0.72, 0, 1),
  swap: cubicBezier(0.2, 0, 0, 1),
  pulse: cubicBezier(0.4, 0, 0.6, 1),
} as const

export const duration = {
  /** Press feedback. */
  press: 160,
  /** Fades, list changes and exits. */
  fast: 150,
  /** Entrances, tab thumbs and icon swaps. */
  base: 200,
  /** Sheets. */
  sheet: 300,
  /** Loading indicators wait this long, so a fast load never flashes one. */
  revealDelay: 150,
} as const

export const PRESSED_SCALE = 0.97
