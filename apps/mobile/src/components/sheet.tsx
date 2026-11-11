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
import { GestureDetector, GestureHandlerRootView, usePanGesture } from "react-native-gesture-handler"
import Animated, {
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated"
import { scheduleOnRN } from "react-native-worklets"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon, type IconName } from "@/components/icon"
import { IconButton } from "@/components/ui"
import { cssEase, duration, ease, sheetEntering } from "@/constants/motion"
import { HIT, mono, radius, subheading } from "@/constants/theme"
import { GroupedCard } from "@/components/grouped-card"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

const SHEET_PADDING = 12
const SHEET_RADIUS = 28
const SHEET_MAX_WIDTH = 640
const DISMISS_SHARE = 0.35
const DISMISS_VELOCITY = 900
const PROJECTION = 0.2
const SETTLE = { damping: 32, stiffness: 340, mass: 1 } as const
const MAX_LIFT = 24

const rubberBand = (distance: number) => {
  "worklet"
  return -Math.sqrt(-distance) * 4
}

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
  header?: ReactNode
  action?: ReactNode
  fit?: boolean
  children: ReactNode
}) {
  return (
    <Modal
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="fade"
      visible={open}
      onRequestClose={onClose}
    >
      {/* FIXME: A Modal is its own native root, so gestures inside it need their own GestureHandlerRootView. */}
      <GestureHandlerRootView style={styles.fill}>
        <SheetFrame>
          <SheetBody title={title} onClose={onClose} header={header} action={action} fit={fit}>
            {children}
          </SheetBody>
        </SheetFrame>
      </GestureHandlerRootView>
    </Modal>
  )
}

function SheetBody({
  title,
  onClose,
  header,
  action,
  fit,
  children,
}: {
  title: string
  onClose: () => void
  header?: ReactNode
  action?: ReactNode
  fit: boolean
  children: ReactNode
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const reduced = useReducedMotion()
  const fullScreen = Platform.OS === "android" && !fit && width < SHEET_MAX_WIDTH
  const offset = useSharedValue(0)
  const start = useSharedValue(0)
  const height = useSharedValue(1)

  const drag = usePanGesture({
    enabled: !fullScreen,
    activeOffsetY: [-4, 4],
    onActivate: () => {
      "worklet"
      cancelAnimation(offset)
      start.set(offset.get())
    },
    onUpdate: (event) => {
      "worklet"
      const next = start.get() + event.translationY
      offset.set(next < 0 ? rubberBand(next) : next)
    },
    onDeactivate: (event) => {
      "worklet"
      const projected = offset.get() + event.velocityY * PROJECTION
      if (projected > height.get() * DISMISS_SHARE || event.velocityY > DISMISS_VELOCITY) {
        if (reduced) {
          scheduleOnRN(onClose)
          return
        }
        const remaining = Math.max(0, height.get() - offset.get())
        const time = Math.min(duration.sheet, Math.max(120, (remaining / Math.max(event.velocityY, 1)) * 1000))
        offset.set(withTiming(height.get(), { duration: time, easing: ease.out }, () => scheduleOnRN(onClose)))
      } else {
        offset.set(reduced ? 0 : withSpring(0, { ...SETTLE, velocity: event.velocityY }))
      }
    },
  })

  const sheetMotion = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(offset.get(), -MAX_LIFT) }] }))
  const scrimMotion = useAnimatedStyle(() => ({
    opacity: interpolate(offset.get(), [0, height.get()], [1, 0], "clamp"),
  }))

  return (
    <>
      <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, scrimMotion]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_sheet_close")}
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }]}
        />
      </Animated.View>
      {!fullScreen && <View pointerEvents="none" style={fit ? styles.fill : { height: insets.top + 12 }} />}
      <Animated.View
        entering={sheetEntering}
        accessibilityViewIsModal
        onLayout={(event) => {
          height.set(event.nativeEvent.layout.height)
        }}
        style={[
          styles.sheet,
          fit ? styles.fitSheet : styles.fill,
          fullScreen && { ...styles.fullScreen, paddingTop: insets.top },
          {
            paddingBottom: SHEET_PADDING + insets.bottom,
            backgroundColor: theme.sheet,
            borderColor: theme.border,
          },
          sheetMotion,
        ]}
      >
        <View pointerEvents="none" style={[styles.underhang, { backgroundColor: theme.sheet }]} />
        <GestureDetector gesture={drag}>
          <View style={styles.handle}>
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
          </View>
        </GestureDetector>
        {header}
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={fit && styles.fitScroll}
          contentContainerStyle={styles.sections}
        >
          {children}
        </ScrollView>
      </Animated.View>
    </>
  )
}

const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow"
const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide"

// FIXME: A Modal draws edge to edge on Android, so its window does not shrink for the keyboard and this view lifts the sheet instead.
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
  // FIXME: iOS counts the bottom inset in the keyboard's height and Android does not, and the sheet already pads for that inset.
  const lift = Platform.OS === "ios" ? Math.max(0, keyboard - insets.bottom) : keyboard
  return (
    // FIXME: Android lays a Modal out without the system bars first and the entering animation drops the correction, so the window's size is fixed from the first frame.
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

export function Section({
  title,
  role = "radiogroup",
  children,
}: {
  title: string
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
  iconColor,
  color,
  monospace = false,
  selected,
  role = "radio",
  disabled = false,
  style,
  onPress,
}: {
  label: string
  hint?: string
  icon?: IconName
  iconColor?: string
  color?: string
  monospace?: boolean
  selected: boolean
  role?: "radio" | "checkbox"
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  onPress: () => void
}) {
  const theme = useTheme()
  const foreground = disabled ? theme.textMuted : (color ?? theme.text)
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={hint}
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.option, style, pressed && { backgroundColor: theme.sheetRaised }]}
    >
      {icon !== undefined && <Icon name={icon} size={18} color={disabled ? foreground : (iconColor ?? foreground)} />}
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
  underhang: { position: "absolute", left: 0, right: 0, top: "100%", height: MAX_LIFT },
  fullScreen: { borderTopLeftRadius: 0, borderTopRightRadius: 0, borderTopWidth: 0 },
  handle: { gap: 8, paddingTop: 6, marginTop: -6 },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: radius.full },
  sheetHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerSlot: { width: HIT },
  sheetTitle: { flex: 1, fontSize: 17, fontWeight: "600", textAlign: "center" },
  sections: { gap: 16, paddingTop: 4 },
  section: { gap: 6 },
  sectionTitle: { fontSize: 13, fontWeight: "600", paddingHorizontal: 16 },
})
