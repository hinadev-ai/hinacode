import type { ReactNode } from "react"
import { Pressable, type PressableProps, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native"
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated"
import { Icon } from "@/components/icon"
import { cssEase, duration, ease, PRESSED_SCALE } from "@/constants/motion"

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/** Shrinks a little while pressed, like the desktop's `pressable` utility. Reduce motion keeps it still. */
export function PressableScale({
  style,
  onPressIn,
  onPressOut,
  ...props
}: Omit<PressableProps, "style"> & { style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion()
  const scale = useSharedValue(1)
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }))
  const scaleTo = (value: number) => {
    if (!reduced) scale.set(withTiming(value, { duration: duration.press, easing: ease.out }))
  }
  return (
    <AnimatedPressable
      {...props}
      onPressIn={(event) => {
        scaleTo(PRESSED_SCALE)
        onPressIn?.(event)
      }}
      onPressOut={(event) => {
        scaleTo(1)
        onPressOut?.(event)
      }}
      style={[style, animated]}
    />
  )
}

const spin = { from: { transform: [{ rotate: "0deg" }] }, to: { transform: [{ rotate: "360deg" }] } }

/** The desktop's 0.6 s loader. Reduce motion shows it still. */
export function Spinner({ size = 16, color }: { size?: number; color: string }) {
  const reduced = useReducedMotion()
  return (
    <Animated.View
      style={
        reduced
          ? undefined
          : {
              animationName: spin,
              animationDuration: 600,
              animationIterationCount: "infinite",
              animationTimingFunction: "linear",
            }
      }
    >
      <Icon name="RiLoader4Line" size={size} color={color} />
    </Animated.View>
  )
}

const ring = {
  from: { transform: [{ scale: 1 }], opacity: 1 },
  "75%": { transform: [{ scale: 2.5 }], opacity: 0 },
  to: { transform: [{ scale: 2.5 }], opacity: 0 },
}

/**
 * Rings out from its parent three times and then rests, like the desktop's `animate-attention`, so a thread
 * that starts waiting catches the eye of someone looking at another one. Reduce motion leaves it out.
 */
export function AttentionRing({ color }: { color: string }) {
  const reduced = useReducedMotion()
  if (reduced) return null
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.ring,
        {
          borderColor: color,
          animationName: ring,
          animationDuration: 1000,
          animationIterationCount: 3,
          animationTimingFunction: cssEase.out,
          animationFillMode: "forwards",
        },
      ]}
    />
  )
}

const fadeIn = { from: { opacity: 0 }, to: { opacity: 1 } }

/** Loading indicators wait before they fade in, so a fast load never flashes one. */
export function Reveal({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <Animated.View
      style={[
        style,
        {
          animationName: fadeIn,
          animationDuration: duration.base,
          animationDelay: duration.revealDelay,
          animationFillMode: "both",
          animationTimingFunction: cssEase.out,
        },
      ]}
    >
      {children}
    </Animated.View>
  )
}

/** Fades content in once, when it mounts. Opacity only, so it stays under reduce motion. */
export function FadeIn({
  children,
  style,
  enabled = true,
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  enabled?: boolean
}) {
  return (
    <Animated.View
      style={[
        style,
        enabled && { animationName: fadeIn, animationDuration: duration.fast, animationTimingFunction: cssEase.out },
      ]}
    >
      {children}
    </Animated.View>
  )
}

const rise = { from: { opacity: 0, transform: [{ translateY: 4 }] } }

/** A card that appears while on screen rises 4 px as it fades in. Reduce motion keeps the fade. */
export function RiseIn({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion()
  return (
    <Animated.View
      style={[
        style,
        {
          animationName: reduced ? fadeIn : rise,
          animationDuration: duration.base,
          animationTimingFunction: cssEase.out,
        },
      ]}
    >
      {children}
    </Animated.View>
  )
}

/**
 * Cross-fades between two icons, shrinking the one that leaves, like the desktop's send and stop button.
 * Reduce motion keeps the cross-fade and drops the scale.
 */
export function IconSwap({ showSecond, first, second }: { showSecond: boolean; first: ReactNode; second: ReactNode }) {
  const reduced = useReducedMotion()
  const layer = (visible: boolean) => ({
    opacity: visible ? 1 : 0,
    transform: [{ scale: visible || reduced ? 1 : 0.25 }],
    transitionProperty: ["opacity", "transform"] as ["opacity", "transform"],
    transitionDuration: duration.base,
    transitionTimingFunction: cssEase.swap,
  })
  return (
    <View>
      <Animated.View style={layer(!showSecond)}>{first}</Animated.View>
      <Animated.View style={[styles.overlay, layer(showSecond)]}>{second}</Animated.View>
    </View>
  )
}

/** Turns a disclosure chevron a quarter turn when it opens. */
export function Rotate({ turned, children }: { turned: boolean; children: ReactNode }) {
  const reduced = useReducedMotion()
  return (
    <Animated.View
      style={{
        transform: [{ rotate: turned ? "90deg" : "0deg" }],
        transitionProperty: "transform",
        transitionDuration: reduced ? 0 : duration.fast,
        transitionTimingFunction: cssEase.out,
      }}
    >
      {children}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  ring: { ...StyleSheet.absoluteFill, margin: 2, borderRadius: 999, borderWidth: 1 },
})
