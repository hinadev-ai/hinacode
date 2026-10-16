import type { ReactNode } from "react"
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon, type IconName } from "@/components/icon"
import { IconButton } from "@/components/ui"
import { Colors, HIT, mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"

const SHEET_PADDING = 8

/** A full-height sheet that slides up over the thread, with a title and a close button. */
export function Sheet({
  title,
  open,
  onClose,
  header,
  children,
}: {
  title: string
  open: boolean
  onClose: () => void
  /** Shown under the title and above the scrolling content, such as a search field. */
  header?: ReactNode
  children: ReactNode
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <Modal transparent animationType="slide" visible={open} onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={[styles.backdrop, { height: insets.top + 12 }]}
      />
      <View
        accessibilityViewIsModal
        style={[
          styles.sheet,
          {
            paddingBottom: SHEET_PADDING + insets.bottom,
            backgroundColor: theme.background,
            borderColor: theme.border,
          },
        ]}
      >
        <View style={styles.sheetHeader}>
          <Text accessibilityRole="header" style={[styles.sheetTitle, { color: theme.text }]}>
            {title}
          </Text>
          <IconButton icon="RiCloseLine" accessibilityLabel="Close" onPress={onClose} />
        </View>
        {header}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sections}>
          {children}
        </ScrollView>
      </View>
    </Modal>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme()
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={title} style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>{title}</Text>
      {children}
    </View>
  )
}

export function OptionRow({
  label,
  hint,
  icon,
  color,
  monospace = false,
  selected,
  onPress,
}: {
  label: string
  hint?: string
  icon?: IconName
  color?: string
  monospace?: boolean
  selected: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const foreground = color ?? theme.text
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.option, (pressed || selected) && { backgroundColor: theme.surface }]}
    >
      {icon !== undefined && <Icon name={icon} size={18} color={foreground} />}
      <View style={styles.optionText}>
        <Text
          numberOfLines={monospace ? 1 : undefined}
          style={[styles.optionLabel, monospace && styles.mono, { color: foreground }]}
        >
          {label}
        </Text>
        {hint !== undefined && (
          <Text numberOfLines={monospace ? 1 : undefined} style={[styles.optionHint, { color: theme.textMuted }]}>
            {hint}
          </Text>
        )}
      </View>
      {selected && <Icon name="RiCheckLine" size={18} color={theme.text} />}
    </Pressable>
  )
}

export const sheetStyles = StyleSheet.create({
  option: {
    minHeight: HIT + 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.lg - SHEET_PADDING,
  },
  optionText: { flex: 1, gap: 2 },
  optionLabel: { fontSize: 15, fontWeight: "500" },
  optionHint: { fontSize: 13 },
  mono: { fontFamily: mono, fontSize: 14 },
})

const styles = StyleSheet.create({
  ...sheetStyles,
  // The scrim is dark in both themes, so it borrows the dark palette's background.
  backdrop: { backgroundColor: Colors.dark.background, opacity: 0.5 },
  sheet: {
    flex: 1,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: SHEET_PADDING,
  },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 12 },
  sheetTitle: { fontSize: 16, fontWeight: "600" },
  sections: { gap: 16, paddingTop: 4 },
  section: { gap: 2 },
  sectionTitle: { fontSize: 13, fontWeight: "600", paddingHorizontal: 12, paddingVertical: 6 },
})
