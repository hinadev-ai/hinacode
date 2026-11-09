import type { ProviderId } from "@shared/agent.ts"
import { type ReactNode, useState } from "react"
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  Switch,
  type SwitchProps,
  Text,
  View,
  type ViewStyle,
} from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { Icon, type IconName } from "@/components/icon"
import { PressableScale, Spinner } from "@/components/motion"
import { cssEase, duration } from "@/constants/motion"
import { HIT, type Palette, PILL_HEIGHT, ProviderColors, radius } from "@/constants/theme"
import { useScheme, useTheme } from "@/hooks/use-theme"
import type { ConnectionStatus } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { motion } from "@/lib/motion"

type Variant = "primary" | "secondary" | "danger" | "ghost" | "dangerGhost"

type ButtonProps = Omit<PressableProps, "children" | "style"> & { style?: StyleProp<ViewStyle> }

export function Button({
  label,
  icon,
  variant = "secondary",
  busy = false,
  disabled,
  style,
  ...props
}: ButtonProps & { label: string; icon?: IconName; variant?: Variant; busy?: boolean }) {
  const theme = useTheme()
  const colors = buttonColors(theme, variant, disabled === true)
  const inactive = disabled === true || busy
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-disabled={inactive}
      aria-busy={busy}
      disabled={inactive}
      style={[styles.button, { backgroundColor: colors.bg, borderColor: colors.border }, style]}
      {...props}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.fg} />
      ) : (
        <>
          {icon !== undefined && <Icon name={icon} size={16} color={colors.fg} />}
          <Text style={[styles.buttonLabel, { color: colors.fg }]}>{label}</Text>
        </>
      )}
    </PressableScale>
  )
}

export function IconButton({
  icon,
  variant = "ghost",
  busy = false,
  disabled,
  style,
  ...props
}: Omit<ButtonProps, "accessibilityLabel"> & {
  icon: IconName
  accessibilityLabel: string
  variant?: Variant
  busy?: boolean
}) {
  const theme = useTheme()
  const colors = buttonColors(theme, variant, disabled === true)
  const inactive = disabled === true || busy
  return (
    <PressableScale
      accessibilityRole="button"
      aria-disabled={inactive}
      aria-busy={busy}
      disabled={inactive}
      style={[styles.iconButton, { backgroundColor: colors.bg, borderColor: colors.border }, style]}
      {...props}
    >
      {busy ? <Spinner size={18} color={colors.fg} /> : <Icon name={icon} size={20} color={colors.fg} />}
    </PressableScale>
  )
}

/** A switch in the app's colors. react-native-web paints the thumb teal unless told otherwise. */
export function Toggle(props: Omit<SwitchProps, "trackColor" | "thumbColor">) {
  const theme = useTheme()
  const webThumb = { activeThumbColor: "#ffffff" } as object
  return (
    <Switch
      {...props}
      {...webThumb}
      trackColor={{ true: theme.primary, false: theme.controlOff }}
      thumbColor="#ffffff"
    />
  )
}

const buttonColors = (theme: Palette, variant: Variant, disabled: boolean) => {
  const transparent = variant === "ghost" || variant === "dangerGhost"
  if (disabled && transparent) return { bg: "transparent", fg: theme.textMuted, border: "transparent" }
  if (disabled) return { bg: theme.disabled, fg: theme.textMuted, border: theme.disabled }
  return {
    primary: { bg: theme.primary, fg: theme.onPrimary, border: theme.primary },
    secondary: { bg: theme.surface, fg: theme.text, border: theme.border },
    danger: { bg: theme.dangerBg, fg: theme.danger, border: theme.dangerBg },
    ghost: { bg: "transparent", fg: theme.text, border: "transparent" },
    dangerGhost: { bg: "transparent", fg: theme.danger, border: "transparent" },
  }[variant]
}

export type Tone = "neutral" | "attention" | "running" | "danger"

export function Pill({ label, tone, icon }: { label: string; tone: Tone; icon?: IconName }) {
  const theme = useTheme()
  const [fg, bg] = toneColors(theme)[tone]
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {icon === "Spinner" ? (
        <Spinner size={12} color={fg} />
      ) : (
        icon !== undefined && <Icon name={icon} size={12} color={fg} />
      )}
      <Text style={[styles.pillLabel, { color: fg }]}>{label}</Text>
    </View>
  )
}

const toneColors = (theme: Palette): Record<Tone, [string, string]> => ({
  neutral: [theme.textMuted, theme.neutralBg],
  attention: [theme.attention, theme.attentionBg],
  running: [theme.running, theme.runningBg],
  danger: [theme.danger, theme.dangerBg],
})

type Status = { label: string; tone: Tone; icon?: IconName }

const connectionLabel: Record<ConnectionStatus, Status> = {
  connected: { label: copy("mobile_connection_connected"), tone: "running", icon: "Cloud" },
  connecting: { label: copy("mobile_connection_connecting"), tone: "neutral", icon: "Spinner" },
  offline: { label: copy("mobile_connection_offline"), tone: "attention", icon: "CloudOff" },
  unauthorized: { label: copy("mobile_connection_unauthorized"), tone: "danger", icon: "Unlink" },
}

const fadeIn = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: duration.fast } }

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const badge = connectionLabel[status]
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={copy("mobile_connection_label", { status: badge.label })}
      testID="connection-status"
    >
      <Pill {...badge} />
    </View>
  )
}

const providerMark: Record<ProviderId, IconName> = {
  claude: "RiClaudeFill",
  codex: "RiOpenaiFill",
  muse: "RiMetaFill",
  opencode: "OpencodeMark",
  magpie: "MagpieMark",
}

const providerName: Record<ProviderId, string> = {
  claude: copy("mobile_provider_claude"),
  codex: copy("mobile_provider_codex"),
  muse: copy("mobile_provider_muse"),
  opencode: copy("mobile_provider_opencode"),
  magpie: copy("mobile_provider_magpie"),
}

/** The provider's logo and name, muted, for meta rows. */
export function ProviderLabel({ provider, size = 13 }: { provider: ProviderId; size?: number }) {
  const theme = useTheme()
  return (
    <View style={styles.provider}>
      <ProviderMark provider={provider} size={14} />
      <Text style={{ color: theme.textMuted, fontSize: size }}>{providerName[provider]}</Text>
    </View>
  )
}

const noticeIcon: Partial<Record<Tone, IconName>> = {
  danger: "Warning",
  attention: "Warning",
  running: "CheckCircle",
}

export function Notice({ text, tone = "neutral" }: { text: string; tone?: Tone }) {
  const theme = useTheme()
  const [fg, bg] = toneColors(theme)[tone]
  const icon = noticeIcon[tone]
  return (
    <motion.View {...fadeIn} accessibilityRole="alert" style={[styles.notice, { backgroundColor: bg }]}>
      {icon !== undefined && <Icon name={icon} size={16} color={fg} />}
      <Text style={[styles.noticeText, { color: fg }]}>{text}</Text>
    </motion.View>
  )
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: IconName
  title: string
  hint?: string
  action?: ReactNode
}) {
  const theme = useTheme()
  return (
    <View style={styles.empty}>
      <Icon name={icon} size={28} color={theme.textMuted} />
      <Text textBreakStrategy="balanced" style={[styles.emptyTitle, { color: theme.text }]}>
        {title}
      </Text>
      {hint !== undefined && (
        <Text textBreakStrategy="balanced" style={[styles.emptyHint, { color: theme.textMuted }]}>
          {hint}
        </Text>
      )}
      {action}
    </View>
  )
}

export interface Segment<T extends string> {
  readonly value: T
  readonly label: string
  readonly icon?: IconName
}

const SEGMENT_GAP = 3

/** Equal-width tabs whose selected thumb slides to the one picked. */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  accessibilityLabel,
  style,
}: {
  segments: readonly Segment<T>[]
  value: T
  onChange: (value: T) => void
  accessibilityLabel: string
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  const reduced = useReducedMotion()
  const [width, setWidth] = useState(0)
  const index = Math.max(
    0,
    segments.findIndex((segment) => segment.value === value),
  )
  const thumbWidth = (width - SEGMENT_GAP * (segments.length + 1)) / segments.length
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.segments, { backgroundColor: theme.surface }, style]}
    >
      {width > 0 && (
        <Animated.View
          style={[
            styles.thumb,
            {
              width: thumbWidth,
              backgroundColor: theme.background,
              borderColor: theme.border,
              transform: [{ translateX: SEGMENT_GAP + index * (thumbWidth + SEGMENT_GAP) }],
              transitionProperty: "transform",
              transitionDuration: reduced ? 0 : duration.base,
              transitionTimingFunction: cssEase.out,
            },
          ]}
        />
      )}
      {segments.map((segment) => {
        const selected = segment.value === value
        const color = selected ? theme.text : theme.textMuted
        return (
          <Pressable
            key={segment.value}
            testID={`tab-${segment.value}`}
            accessibilityRole="tab"
            accessibilityLabel={segment.label}
            aria-selected={selected}
            onPress={() => onChange(segment.value)}
            style={styles.segment}
          >
            {segment.icon !== undefined && <Icon name={segment.icon} size={16} color={color} />}
            <Text numberOfLines={1} style={[styles.segmentLabel, { color }]}>
              {segment.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export interface Tab<T extends string> {
  readonly value: T
  readonly label: string
}

type TabLayout = { readonly x: number; readonly width: number }

/** Text tabs with an underline that slides to the selected one, like the desktop sidebar's. */
export function UnderlineTabs<T extends string>({
  tabs,
  value,
  onChange,
  accessibilityLabel,
  style,
}: {
  tabs: readonly Tab<T>[]
  value: T
  onChange: (value: T) => void
  accessibilityLabel: string
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  const reduced = useReducedMotion()
  const [layouts, setLayouts] = useState<Readonly<Record<string, TabLayout>>>({})
  const active = layouts[value]
  const transition = {
    transitionDuration: reduced ? 0 : duration.base,
    transitionTimingFunction: cssEase.out,
  }
  return (
    <View accessibilityRole="tablist" accessibilityLabel={accessibilityLabel} style={[styles.lineTabs, style]}>
      {tabs.map((tab) => {
        const selected = tab.value === value
        return (
          <Pressable
            key={tab.value}
            testID={`tab-${tab.value}`}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            aria-selected={selected}
            onLayout={(event) => {
              const { x, width } = event.nativeEvent.layout
              setLayouts((current) => ({ ...current, [tab.value]: { x, width } }))
            }}
            onPress={() => onChange(tab.value)}
            style={styles.lineTab}
          >
            <Animated.Text
              numberOfLines={1}
              style={[
                styles.lineTabLabel,
                { color: selected ? theme.text : theme.textMuted, transitionProperty: "color", ...transition },
              ]}
            >
              {tab.label}
            </Animated.Text>
          </Pressable>
        )
      })}
      {active !== undefined && (
        <Animated.View
          style={[
            styles.underline,
            {
              backgroundColor: theme.text,
              width: active.width,
              transform: [{ translateX: active.x }],
              transitionProperty: ["transform", "width"],
              ...transition,
            },
          ]}
        />
      )}
    </View>
  )
}

/** An agent's mark in its brand color, as at the start of a desktop sidebar row. */
export function ProviderMark({ provider, size = 16 }: { provider: ProviderId; size?: number }) {
  return <Icon name={providerMark[provider]} size={size} color={ProviderColors[useScheme()][provider]} />
}

const styles = StyleSheet.create({
  lineTabs: { flexDirection: "row" },
  lineTab: { minHeight: HIT, justifyContent: "center", paddingHorizontal: 10 },
  lineTabLabel: { fontSize: 15, fontWeight: "500" },
  underline: { position: "absolute", left: 0, bottom: 0, height: 2 },
  segments: { flexDirection: "row", padding: SEGMENT_GAP, gap: SEGMENT_GAP, borderRadius: radius.md + SEGMENT_GAP },
  thumb: {
    position: "absolute",
    top: SEGMENT_GAP,
    bottom: SEGMENT_GAP,
    left: 0,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  segment: {
    flex: 1,
    minHeight: HIT - 4,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  segmentLabel: { flexShrink: 1, fontSize: 14, fontWeight: "600" },
  button: {
    minHeight: HIT,
    minWidth: HIT,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonLabel: { fontSize: 15, fontWeight: "600" },
  iconButton: {
    width: HIT,
    height: HIT,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: radius.full,
    paddingHorizontal: 8,
    height: PILL_HEIGHT,
    alignSelf: "flex-start",
  },
  pillLabel: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  provider: { flexDirection: "row", alignItems: "center", gap: 4 },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderRadius: 8, padding: 12 },
  noticeText: { flex: 1, fontSize: 14, lineHeight: 18 },
  empty: { alignItems: "center", gap: 8, paddingVertical: 32, paddingHorizontal: 20 },
  emptyTitle: { fontSize: 15, fontWeight: "600", textAlign: "center" },
  emptyHint: { fontSize: 13, lineHeight: 18, textAlign: "center" },
})
