import { type ComponentProps, useEffect, useEffectEvent } from "react"
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native"
import Animated, {
  type EasingFunction,
  type EasingFunctionFactory,
  type LayoutAnimation,
  ReduceMotion,
  type SharedValue,
  type StyleProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated"
import { duration, ease, listLayout } from "@/constants/motion"

export interface Tween {
  type?: "tween"
  duration?: number
  ease?: EasingFunction | EasingFunctionFactory
  delay?: number
}

export interface Spring {
  type: "spring"
  visualDuration: number
  delay?: number
}

type ValueTransition = Tween | Spring

type Key = "opacity" | "y" | "scale" | "rotate" | "backgroundColor"

export type Transition = ValueTransition & { [K in Key]?: ValueTransition }

export interface Target {
  opacity?: number
  y?: number
  scale?: number
  rotate?: number
  backgroundColor?: string
  transition?: Transition
}

export interface MotionProps {
  initial?: Target | false
  animate?: Target
  exit?: Pick<Target, "opacity" | "y" | "transition">
  transition?: Transition
  layout?: boolean
}

const rest = { opacity: 1, y: 0, scale: 1, rotate: 0, backgroundColor: "transparent" } satisfies Record<Key, unknown>

const moves = (key: Key) => {
  "worklet"
  return key === "y" || key === "scale" || key === "rotate"
}

const springConfig = (visualDuration: number) => {
  "worklet"
  const root = (2 * Math.PI) / ((visualDuration / 1000) * 1.2)
  const stiffness = root * root
  return { stiffness, damping: 2 * Math.sqrt(stiffness), mass: 1, reduceMotion: ReduceMotion.Never }
}

function animation<T extends number | string>(key: Key, target: T, transition: Transition | undefined): T {
  "worklet"
  const picked = transition?.[key] ?? transition
  const run =
    picked?.type === "spring"
      ? withSpring(target, springConfig(picked.visualDuration))
      : withTiming(target, {
          duration: picked?.duration ?? duration.base,
          easing: picked?.ease ?? ease.out,
          reduceMotion: ReduceMotion.Never,
        })
  return picked?.delay ? withDelay(picked.delay, run, ReduceMotion.Never) : run
}

function useMotion({ initial, animate, exit, transition, layout, whileTap }: MotionProps & { whileTap?: Target }) {
  const reduced = useReducedMotion()
  const resting = (key: Key) => animate?.[key] ?? rest[key]
  const start = (key: Key) =>
    initial === false || initial?.[key] === undefined || (reduced && moves(key)) ? resting(key) : initial[key]
  const values: Record<Key, SharedValue<number | string>> = {
    opacity: useSharedValue(start("opacity")),
    y: useSharedValue(start("y")),
    scale: useSharedValue(start("scale")),
    rotate: useSharedValue(start("rotate")),
    backgroundColor: useSharedValue(start("backgroundColor")),
  }

  const animateTo = (
    target: Target | undefined,
    resolve: (key: Key) => number | string | undefined,
    reduce: boolean,
  ) => {
    for (const key of Object.keys(values) as Key[]) {
      const to = resolve(key)
      if (to === undefined) continue
      if (reduce && moves(key)) values[key].set(resting(key))
      else values[key].set(animation(key, to, target?.transition ?? transition))
    }
  }

  const syncAnimate = useEffectEvent((destination: Pick<Target, Key>, reduce: boolean) =>
    animateTo(animate, (key) => destination[key], reduce),
  )
  const { opacity: toOpacity, y: toY, scale: toScale, rotate: toRotate, backgroundColor: toBackground } = animate ?? {}
  useEffect(() => {
    syncAnimate({ opacity: toOpacity, y: toY, scale: toScale, rotate: toRotate, backgroundColor: toBackground }, reduced)
  }, [toOpacity, toY, toScale, toRotate, toBackground, reduced])

  const named = (key: Key) =>
    animate?.[key] !== undefined || whileTap?.[key] !== undefined || (initial || undefined)?.[key] !== undefined
  const styleOpacity = named("opacity")
  const styleY = named("y")
  const styleScale = named("scale")
  const styleRotate = named("rotate")
  const styleBackground = named("backgroundColor")
  const { opacity, y, scale, rotate, backgroundColor } = values
  const style = useAnimatedStyle(() => {
    const transform = []
    if (styleY) transform.push({ translateY: y.get() as number })
    if (styleScale) transform.push({ scale: scale.get() as number })
    if (styleRotate) transform.push({ rotate: `${rotate.get()}deg` })
    return {
      ...(styleOpacity && { opacity: opacity.get() as number }),
      ...(styleBackground && { backgroundColor: backgroundColor.get() as string }),
      ...(transform.length > 0 && { transform }),
    }
  })

  const exiting =
    exit &&
    ((): LayoutAnimation => {
      "worklet"
      const exitTransition = exit.transition ?? transition
      const initialValues: StyleProps = {
        ...(exit.opacity !== undefined && { opacity: opacity.get() as number }),
        ...(exit.y !== undefined && !reduced && { transform: [{ translateY: y.get() as number }] }),
      }
      const animations: StyleProps = {
        ...(exit.opacity !== undefined && { opacity: animation("opacity", exit.opacity, exitTransition) }),
        ...(exit.y !== undefined && !reduced && { transform: [{ translateY: animation("y", exit.y, exitTransition) }] }),
      }
      return { initialValues, animations }
    })

  const tap = {
    onPressIn: () => animateTo(whileTap, (key) => whileTap?.[key], reduced),
    onPressOut: () => animateTo(animate, (key) => (whileTap?.[key] === undefined ? undefined : resting(key)), reduced),
  }

  return { style, exiting, layout: layout && !reduced ? listLayout : undefined, tap }
}

function MotionView({
  initial,
  animate,
  exit,
  transition,
  layout,
  style,
  ...props
}: MotionProps & Omit<ComponentProps<typeof Animated.View>, "exiting" | "layout">) {
  const motion = useMotion({ initial, animate, exit, transition, layout })
  return <Animated.View {...props} style={[style, motion.style]} exiting={motion.exiting} layout={motion.layout} />
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

function MotionPressable({
  initial,
  animate,
  exit,
  transition,
  layout,
  whileTap,
  style,
  onPressIn,
  onPressOut,
  ...props
}: MotionProps &
  Omit<PressableProps, "style"> & {
    style?: StyleProp<ViewStyle>
    whileTap?: Target
  }) {
  const motion = useMotion({ initial, animate, exit, transition, layout, whileTap })
  return (
    <AnimatedPressable
      {...props}
      onPressIn={(event) => {
        motion.tap.onPressIn()
        onPressIn?.(event)
      }}
      onPressOut={(event) => {
        motion.tap.onPressOut()
        onPressOut?.(event)
      }}
      style={[style, motion.style]}
      exiting={motion.exiting}
      layout={motion.layout}
    />
  )
}

export const motion = { View: MotionView, Pressable: MotionPressable }
