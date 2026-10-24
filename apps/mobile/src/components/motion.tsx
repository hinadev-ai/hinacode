import type { ReactNode } from "react"
import { type PressableProps, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { Icon } from "@/components/icon"
import { cssEase, duration, ease, PRESSED_SCALE, pressSpring, rise } from "@/constants/motion"
import { motion } from "@/lib/motion"

/** Shrinks a little while pressed, like the desktop's `pressable` utility. Reduce motion keeps it still. */
export function PressableScale(props: Omit<PressableProps, "style"> & { style?: StyleProp<ViewStyle> }) {
  return <motion.Pressable {...props} whileTap={{ scale: PRESSED_SCALE }} transition={pressSpring} />
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

/** Loading indicators wait before they fade in, so a fast load never flashes one. */
export function Reveal({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <motion.View
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: duration.revealDelay }}
      style={style}
    >
      {children}
    </motion.View>
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
    <motion.View
      initial={enabled && { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: duration.fast }}
      style={style}
    >
      {children}
    </motion.View>
  )
}

/** A card that appears while on screen rises 4 px as it fades in. Reduce motion keeps the fade. */
export function RiseIn({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <motion.View {...rise} style={style}>
      {children}
    </motion.View>
  )
}

/**
 * Cross-fades between two icons, shrinking the one that leaves, like the desktop's send and stop button.
 * Reduce motion keeps the cross-fade and drops the scale.
 */
export function IconSwap({ showSecond, first, second }: { showSecond: boolean; first: ReactNode; second: ReactNode }) {
  const reduced = useReducedMotion()
  const layer = (visible: boolean) => ({ opacity: visible ? 1 : 0, scale: visible || reduced ? 1 : 0.25 })
  const transition = { ease: ease.swap }
  return (
    <View>
      <motion.View animate={layer(!showSecond)} transition={transition}>
        {first}
      </motion.View>
      <motion.View animate={layer(showSecond)} transition={transition} style={styles.overlay}>
        {second}
      </motion.View>
    </View>
  )
}

/** Turns a disclosure chevron a quarter turn when it opens. */
export function Rotate({ turned, children }: { turned: boolean; children: ReactNode }) {
  return (
    <motion.View animate={{ rotate: turned ? 90 : 0 }} transition={{ duration: duration.fast }}>
      {children}
    </motion.View>
  )
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  ring: { ...StyleSheet.absoluteFill, margin: 2, borderRadius: 999, borderWidth: 1 },
})
