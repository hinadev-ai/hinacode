import { StyleSheet, View } from "react-native"
import { HIT, radius } from "@/constants/theme"

export const LINE_HEIGHT = HIT

export function ActivityMeter({ segments }: { segments: readonly { key: string; color: string }[] }) {
  return (
    <View aria-hidden style={styles.meter}>
      {segments.map((segment) => (
        <View key={segment.key} style={[styles.segment, { backgroundColor: segment.color }]} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  meter: { width: 40, height: 6, flexDirection: "row", gap: 1, borderRadius: radius.full, overflow: "hidden" },
  segment: { flex: 1 },
})
