import { StyleSheet, View } from "react-native"
import { HIT, radius } from "@/constants/theme"

/** The height of one collapsed line in the activity tray. */
export const LINE_HEIGHT = HIT

/** A thin bar with one segment per item, colored by its status, that leads each activity tray line. */
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
