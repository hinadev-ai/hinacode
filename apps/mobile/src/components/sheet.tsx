import { type ReactNode, useEffect, useState } from "react"
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon, type IconName } from "@/components/icon"
import { IconButton } from "@/components/ui"
import { cssEase, duration, sheetEntering } from "@/constants/motion"
import { HIT, mono, radius, subheading } from "@/constants/theme"
import { GroupedCard } from "@/components/grouped-card"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

const SHEET_PADDING = 12
const SHEET_RADIUS = 28
const SHEET_MAX_WIDTH = 640

/**
 * A sheet with a grabber, a round close button and a centred title, full height by default or as tall as its content
 * with `fit`. The scrim fades while the sheet rises; both fade out together, which is quicker than the way in. A full
 * height sheet on an Android phone covers the whole screen, as Material's full-screen dialog does.
 */
export function Sheet({
  title,
  open,
  onClose,
  header,
  action,
  fit = false,
  children,
}: {
  title: string
  open: boolean
  onClose: () => void
  /** Shown under the title and above the scrolling content, such as a search field. */
  header?: ReactNode
  /** A round button at the header's trailing edge, opposite the close button. */
  action?: ReactNode
  /** Sizes the sheet to a short list instead of filling the screen. */
  fit?: boolean
  children: ReactNode
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
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
      <SheetFrame>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_sheet_close")}
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }]}
        />
        {!fullScreen && <View pointerEvents="none" style={fit ? styles.fill : { height: insets.top + 12 }} />}
        <Animated.View
          entering={sheetEntering}
          accessibilityViewIsModal
          style={[
            styles.sheet,
            fit ? styles.fitSheet : styles.fill,
            fullScreen && { ...styles.fullScreen, paddingTop: insets.top },
            {
              paddingBottom: SHEET_PADDING + insets.bottom,
              backgroundColor: theme.sheet,
              borderColor: theme.border,
            },
          ]}
        >
          {!fullScreen && <View style={[styles.grabber, { backgroundColor: theme.surfaceStrong }]} />}
          <View style={styles.sheetHeader}>
            <IconButton
              icon="Close"
              accessibilityLabel={copy("mobile_sheet_close")}
              onPress={onClose}
              style={[styles.round, { backgroundColor: theme.card, borderColor: theme.border }]}
            />
            <Text
              accessibilityRole="header"
              {...subheading}
              numberOfLines={1}
              style={[styles.sheetTitle, { color: theme.text }]}
            >
              {title}
            </Text>
            {action ?? <View style={styles.headerSlot} />}
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
      </SheetFrame>
    </Modal>
  )
}

const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow"
const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide"

/**
 * The window under a sheet, which rises above the keyboard. A Modal draws edge to edge on Android, so its window does
 * not shrink for the keyboard there. Mounted only while the Modal shows, so a closed sheet keeps no listeners.
 */
function SheetFrame({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const reduced = useReducedMotion()
  const [keyboard, setKeyboard] = useState(0)
  useEffect(() => {
    const subscriptions = [
      Keyboard.addListener(showEvent, (event) => setKeyboard(event.endCoordinates.height)),
      Keyboard.addListener(hideEvent, () => setKeyboard(0)),
    ]
    return () => subscriptions.forEach((subscription) => subscription.remove())
  }, [])
  // The sheet already pads for the bottom inset, which iOS counts in the keyboard's height and Android does not.
  const lift = Platform.OS === "ios" ? Math.max(0, keyboard - insets.bottom) : keyboard
  return (
    // Android lays a Modal out without the system bars first, then corrects it while the entering animation owns
    // the sheet's frame, which drops the correction. The window's size holds from the first frame.
    <Animated.View
      style={{
        height,
        paddingLeft: insets.left,
        paddingRight: insets.right,
        paddingBottom: lift,
        transitionProperty: "paddingBottom",
        transitionDuration: reduced ? 0 : duration.base,
        transitionTimingFunction: cssEase.out,
      }}
    >
      {children}
    </Animated.View>
  )
}

/** Rows on one card, split by hairlines, as iOS groups a list of options. */
export function Section({
  title,
  role = "radiogroup",
  children,
}: {
  title: string
  /** `group` for a section of switches, which are not one choice among several. */
  role?: "radiogroup" | "group"
  children: ReactNode
}) {
  const theme = useTheme()
  return (
    <View role={role} accessibilityLabel={title} style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>{title}</Text>
      <GroupedCard inset={16}>{children}</GroupedCard>
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
  style,
  onPress,
}: {
  label: string
  hint?: string
  icon?: IconName
  color?: string
  monospace?: boolean
  selected: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  onPress: () => void
}) {
  const theme = useTheme()
  const foreground = disabled ? theme.textMuted : (color ?? theme.text)
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={hint}
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.option, style, pressed && { backgroundColor: theme.sheetRaised }]}
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
      {selected && <Icon name="Check" size={18} color={theme.text} />}
    </Pressable>
  )
}

export const sheetStyles = StyleSheet.create({
  option: {
    minHeight: HIT + 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  optionText: { flex: 1, gap: 2 },
  optionLabel: { fontSize: 16 },
  optionHint: { fontSize: 13 },
  mono: { fontFamily: mono, fontSize: 14 },
  round: { borderRadius: radius.full, boxShadow: "0 2px 8px rgba(0, 0, 0, 0.08)" },
})

const styles = StyleSheet.create({
  ...sheetStyles,
  fill: { flex: 1 },
  fitSheet: { maxHeight: "85%" },
  fitScroll: { flexGrow: 0 },
  // A tablet keeps the sheet to a column, with the scrim on both sides; every phone is narrower.
  sheet: {
    width: "100%",
    maxWidth: SHEET_MAX_WIDTH,
    alignSelf: "center",
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: SHEET_PADDING,
    paddingTop: 6,
    gap: 8,
  },
  fullScreen: { borderTopLeftRadius: 0, borderTopRightRadius: 0, borderTopWidth: 0 },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: radius.full },
  sheetHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerSlot: { width: HIT },
  sheetTitle: { flex: 1, fontSize: 17, fontWeight: "600", textAlign: "center" },
  sections: { gap: 16, paddingTop: 4 },
  section: { gap: 6 },
  sectionTitle: { fontSize: 13, fontWeight: "600", paddingHorizontal: 16 },
})
