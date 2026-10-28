import type { ReactNode } from "react"
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native"
import Animated, { SlideInDown } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon, type IconName } from "@/components/icon"
import { IconButton } from "@/components/ui"
import { duration, ease } from "@/constants/motion"
import { Colors, HIT, mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

const SHEET_PADDING = 8
const SHEET_MAX_WIDTH = 640

const rise = SlideInDown.duration(duration.sheet).easing(ease.drawer)

/**
 * A sheet with a title and a close button, full height by default or as tall as its content with `fit`. The scrim
 * fades while the sheet rises; both fade out together, which is quicker than the way in. A full height sheet on an
 * Android phone covers the whole screen, as Material's full-screen dialog does.
 */
export function Sheet({
  title,
  open,
  onClose,
  header,
  fit = false,
  children,
}: {
  title: string
  open: boolean
  onClose: () => void
  /** Shown under the title and above the scrolling content, such as a search field. */
  header?: ReactNode
  /** Sizes the sheet to a short list instead of filling the screen. */
  fit?: boolean
  children: ReactNode
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const fullScreen = Platform.OS === "android" && !fit && width < SHEET_MAX_WIDTH
  return (
    <Modal
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="fade"
      visible={open}
      onRequestClose={onClose}
    >
      {/* Android lays a Modal out without the system bars first, then corrects it while the entering animation owns
          the sheet's frame, which drops the correction. The window's size holds from the first frame. */}
      <View style={{ height }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_sheet_close")}
          onPress={onClose}
          style={[StyleSheet.absoluteFill, styles.backdrop]}
        />
        {!fullScreen && <View pointerEvents="none" style={fit ? styles.fill : { height: insets.top + 12 }} />}
        <Animated.View
          entering={rise}
          accessibilityViewIsModal
          style={[
            styles.sheet,
            fit ? styles.fitSheet : styles.fill,
            fullScreen && { ...styles.fullScreen, paddingTop: insets.top },
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
            <IconButton icon="RiCloseLine" accessibilityLabel={copy("mobile_sheet_close")} onPress={onClose} />
          </View>
          {header}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={fit && styles.fitScroll}
            contentContainerStyle={styles.sections}
          >
            {children}
          </ScrollView>
        </Animated.View>
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
  disabled = false,
  onPress,
}: {
  label: string
  hint?: string
  icon?: IconName
  color?: string
  monospace?: boolean
  selected: boolean
  disabled?: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const foreground = disabled ? theme.textMuted : (color ?? theme.text)
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
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
  fill: { flex: 1 },
  fitSheet: { maxHeight: "85%" },
  fitScroll: { flexGrow: 0 },
  // A tablet keeps the sheet to a column, with the scrim on both sides; every phone is narrower.
  sheet: {
    width: "100%",
    maxWidth: SHEET_MAX_WIDTH,
    alignSelf: "center",
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: SHEET_PADDING,
  },
  fullScreen: { borderTopLeftRadius: 0, borderTopRightRadius: 0, borderTopWidth: 0 },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 12 },
  sheetTitle: { fontSize: 16, fontWeight: "600" },
  sections: { gap: 16, paddingTop: 4 },
  section: { gap: 2 },
  sectionTitle: { fontSize: 13, fontWeight: "600", paddingHorizontal: 12, paddingVertical: 6 },
})
