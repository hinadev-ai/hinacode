import type { PullRequestStatus } from "@shared/domain.ts"
import { StyleSheet, Text, View } from "react-native"
import { Icon } from "@/components/icon"
import { radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { statusGlyph, statusLabel } from "@/lib/pull-request-labels"

/** The pull request's state as GitHub draws it: its icon and name in the state's color. */
export function PullRequestState({ status }: { status: PullRequestStatus }) {
  const theme = useTheme()
  const glyph = statusGlyph(theme)[status]
  return (
    <View style={[styles.pill, { backgroundColor: theme.neutralBg }]}>
      <Icon {...glyph} size={12} />
      <Text style={[styles.label, { color: glyph.color }]}>{statusLabel(status)}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
  label: { fontSize: 12, fontWeight: "600" },
})
