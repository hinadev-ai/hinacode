import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect"
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from "react-native"
import { useScheme } from "@/hooks/use-theme"

/** The native iOS chrome (toolbar items, search bar, large titles) applies to iPhone and iPad only. */
export const isIOS = Platform.OS === "ios"

/** Liquid Glass exists only where the OS and the build SDK both provide it. Nowhere else changes. */
export const liquidGlass = isIOS && isLiquidGlassAvailable()

/**
 * Fills its parent with the Liquid Glass material and renders nothing where glass is unavailable, so a
 * surface keeps the solid background it already has. The parent clips it with its own corners.
 */
export function GlassFill({ style }: { style?: StyleProp<ViewStyle> }) {
  const scheme = useScheme()
  if (!liquidGlass) return null
  return <GlassView pointerEvents="none" colorScheme={scheme} style={[StyleSheet.absoluteFill, style]} />
}
