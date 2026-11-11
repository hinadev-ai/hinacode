import type { ReactNode } from "react"
import { type PressableProps, type StyleProp, StyleSheet, type TextStyle, View, type ViewStyle } from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { Icon } from "@/components/icon"
import { cssEase, duration, ease, PRESSED_SCALE, pressSpring } from "@/constants/motion"
import { Colors } from "@/constants/theme"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { motion } from "@/lib/motion"

export function PressableScale(props: Omit<PressableProps, "style"> & { style?: StyleProp<ViewStyle> }) {
  return <motion.Pressable {...props} whileTap={{ scale: PRESSED_SCALE }} transition={pressSpring} />
}

const pulse = {
  light: { "50%": { color: Colors.light.text } },
  dark: { "50%": { color: Colors.dark.text } },
}

export function Pulse({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const theme = useTheme()
  const scheme = useScheme()
  const reduced = useReducedMotion()
  return (
    <Animated.Text
      style={[
        style,
        { color: theme.textMuted },
        !reduced && {
          animationName: pulse[scheme],
          animationDuration: 2000,
          animationIterationCount: "infinite",
          animationTimingFunction: cssEase.pulse,
        },
      ]}
    >
      {text}
    </Animated.Text>
  )
}

const spin = { from: { transform: [{ rotate: "0deg" }] }, to: { transform: [{ rotate: "360deg" }] } }

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
      <Icon name="Spinner" size={size} color={color} />
    </Animated.View>
  )
}

const ring = {
  from: { transform: [{ scale: 1 }], opacity: 1 },
  "75%": { transform: [{ scale: 2.5 }], opacity: 0 },
  to: { transform: [{ scale: 2.5 }], opacity: 0 },
}

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
