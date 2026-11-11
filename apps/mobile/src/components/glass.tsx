import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect"
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from "react-native"
import { useScheme } from "@/hooks/use-theme"

export const isIOS = Platform.OS === "ios"

export const largeTitle = { headerLargeTitleEnabled: isIOS, headerTransparent: false }

export const liquidGlass = isIOS && isLiquidGlassAvailable()

export function GlassFill({ style }: { style?: StyleProp<ViewStyle> }) {
  const scheme = useScheme()
  if (!liquidGlass) return null
  return <GlassView pointerEvents="none" colorScheme={scheme} style={[StyleSheet.absoluteFill, style]} />
}
