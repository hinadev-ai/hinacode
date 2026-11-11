import { Children, Fragment, isValidElement, type ReactNode } from "react"
import { StyleSheet, Text, View } from "react-native"
import { radius, subheading } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"

export function GroupedCard({ inset = 0, children }: { inset?: number; children: ReactNode }) {
  const theme = useTheme()
  const rows = Children.toArray(children).filter(isValidElement)
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      {rows.map((row, index) => (
        <Fragment key={row.key}>
          {index > 0 && <View style={[styles.separator, { marginLeft: inset, backgroundColor: theme.border }]} />}
          {row}
        </Fragment>
      ))}
    </View>
  )
}

export function SectionHeading({ label, count }: { label: string; count?: number }) {
  const theme = useTheme()
  return (
    <View style={styles.heading}>
      <Text accessibilityRole="header" {...subheading} style={[styles.label, { color: theme.textResting }]}>
        {label}
        {count !== undefined && <Text style={[styles.count, { color: theme.textMuted }]}>{`  ${count}`}</Text>}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, overflow: "hidden" },
  separator: { height: StyleSheet.hairlineWidth },
  heading: { paddingHorizontal: 8, paddingTop: 20, paddingBottom: 8 },
  label: { fontSize: 15, fontWeight: "600" },
  count: { fontWeight: "400", fontVariant: ["tabular-nums"] },
})
