import { cubicBezier, Easing, FadeIn, FadeOut, LinearTransition, SlideInDown } from "react-native-reanimated"
import type { Spring } from "@/lib/motion"

export const ease = {
  out: Easing.bezier(0.23, 1, 0.32, 1),
  inOut: Easing.bezier(0.77, 0, 0.175, 1),
  drawer: Easing.bezier(0.32, 0.72, 0, 1),
  swap: Easing.bezier(0.2, 0, 0, 1),
} as const

export const cssEase = {
  out: cubicBezier(0.23, 1, 0.32, 1),
  drawer: cubicBezier(0.32, 0.72, 0, 1),
  swap: cubicBezier(0.2, 0, 0, 1),
  pulse: cubicBezier(0.4, 0, 0.6, 1),
} as const

export const duration = {
  press: 160,
  fast: 150,
  base: 200,
  sheet: 300,
  revealDelay: 150,
} as const

export const PRESSED_SCALE = 0.97

export const pressSpring: Spring = { type: "spring", visualDuration: duration.press }

export const rise = { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 } } as const

export const listEntering = FadeIn.duration(duration.fast)
export const listExiting = FadeOut.duration(duration.fast)

export const listLayout = LinearTransition.duration(duration.base).easing(ease.inOut)
export const sheetEntering = SlideInDown.duration(duration.sheet).easing(ease.drawer)
