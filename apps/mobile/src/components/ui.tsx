import type { ProviderId } from "@shared/agent.ts"
import type { ThreadStatus } from "@shared/domain.ts"
import { type ReactNode, useState } from "react"
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { Icon, type IconName } from "@/components/icon"
import { PressableScale, Spinner } from "@/components/motion"
import { cssEase, duration } from "@/constants/motion"
import { HIT, type Palette, radius } from "@/constants/theme"
import { threadStatus } from "@/constants/thread-status"
import { useTheme } from "@/hooks/use-theme"
import type { ConnectionStatus } from "@/lib/connection"

type Variant = "primary" | "secondary" | "danger" | "ghost"

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
  const colors = buttonColors(theme)[variant]
  const inactive = disabled === true || busy
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      style={[
        styles.button,
        { backgroundColor: colors.bg, borderColor: colors.border, opacity: inactive ? 0.5 : 1 },
        style,
      ]}
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
  disabled,
  style,
  ...props
}: Omit<ButtonProps, "accessibilityLabel"> & {
  icon: IconName
  accessibilityLabel: string
  variant?: Variant
}) {
  const theme = useTheme()
  const colors = buttonColors(theme)[variant]
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      style={[
        styles.iconButton,
        { backgroundColor: colors.bg, borderColor: colors.border, opacity: disabled === true ? 0.5 : 1 },
        style,
      ]}
      {...props}
    >
      <Icon name={icon} size={20} color={colors.fg} />
    </PressableScale>
  )
}

const buttonColors = (theme: Palette) => ({
  primary: { bg: theme.primary, fg: theme.onPrimary, border: theme.primary },
  secondary: { bg: theme.surface, fg: theme.text, border: theme.border },
  danger: { bg: theme.dangerBg, fg: theme.danger, border: theme.dangerBg },
  ghost: { bg: "transparent", fg: theme.text, border: "transparent" },
})

export type Tone = "neutral" | "attention" | "running" | "danger"

export function Pill({ label, tone, icon }: { label: string; tone: Tone; icon?: IconName }) {
  const theme = useTheme()
  const [fg, bg] = toneColors(theme)[tone]
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {icon === "RiLoader4Line" ? (
        <Spinner size={12} color={fg} />
      ) : (
        icon !== undefined && <Icon name={icon} size={12} color={fg} />
      )}
      <Text style={[styles.pillLabel, { color: fg }]}>{label}</Text>
    </View>
  )
}

export const toneColors = (theme: Palette): Record<Tone, [string, string]> => ({
  neutral: [theme.textMuted, theme.neutralBg],
  attention: [theme.attention, theme.attentionBg],
  running: [theme.running, theme.runningBg],
  danger: [theme.danger, theme.dangerBg],
})

type Status = { label: string; tone: Tone; icon?: IconName }

export const ThreadStatusPill = ({ status }: { status: ThreadStatus }) => <Pill {...threadStatus[status]} />

const connectionLabel: Record<ConnectionStatus, Status> = {
  connected: { label: "Connected", tone: "running", icon: "RiWifiLine" },
  connecting: { label: "Connecting", tone: "neutral", icon: "RiLoader4Line" },
  offline: { label: "Reconnecting", tone: "attention", icon: "RiWifiOffLine" },
  unauthorized: { label: "Not paired", tone: "danger", icon: "RiLinkUnlinkM" },
}

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const badge = connectionLabel[status]
  return (
    <View accessibilityRole="text" accessibilityLabel={`Connection: ${badge.label}`} testID="connection-status">
      <Pill {...badge} />
    </View>
  )
}

const providerMark: Record<ProviderId, IconName> = {
  claude: "RiClaudeFill",
  codex: "RiOpenaiFill",
  muse: "RiMetaFill",
}

/** The provider's logo and name, muted, for meta rows. */
export function ProviderLabel({ provider, size = 13 }: { provider: ProviderId; size?: number }) {
  const theme = useTheme()
  return (
    <View style={styles.provider}>
      <Icon name={providerMark[provider]} size={14} color={theme.textMuted} />
      <Text style={{ color: theme.textMuted, fontSize: size }}>{provider}</Text>
    </View>
  )
}

const noticeIcon: Partial<Record<Tone, IconName>> = {
  danger: "RiErrorWarningLine",
  attention: "RiErrorWarningLine",
  running: "RiCheckboxCircleLine",
}

export function Notice({ text, tone = "neutral" }: { text: string; tone?: Tone }) {
  const theme = useTheme()
  const [fg, bg] = toneColors(theme)[tone]
  const icon = noticeIcon[tone]
  return (
    <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: bg }]}>
      {icon !== undefined && <Icon name={icon} size={16} color={fg} />}
      <Text style={[styles.noticeText, { color: fg }]}>{text}</Text>
    </View>
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
      <Text style={[styles.emptyTitle, { color: theme.text }]}>{title}</Text>
      {hint !== undefined && <Text style={[styles.emptyHint, { color: theme.textMuted }]}>{hint}</Text>}
      {action}
    </View>
  )
}

export interface Segment<T extends string> {
  readonly value: T
  readonly label: string
  readonly icon?: IconName
  /** A count shown after the label, such as threads that need the developer. */
  readonly count?: number
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
            accessibilityLabel={segment.count ? `${segment.label}, ${segment.count}` : segment.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(segment.value)}
            style={styles.segment}
          >
            {segment.icon !== undefined && <Icon name={segment.icon} size={16} color={color} />}
            <Text numberOfLines={1} style={[styles.segmentLabel, { color }]}>
              {segment.label}
            </Text>
            {segment.count !== undefined && segment.count > 0 && (
              <Text style={[styles.segmentCount, { color: theme.attention }]}>{segment.count}</Text>
            )}
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
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
  segmentCount: { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
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
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
  pillLabel: { fontSize: 12, fontWeight: "600" },
  provider: { flexDirection: "row", alignItems: "center", gap: 4 },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderRadius: 8, padding: 12 },
  noticeText: { flex: 1, fontSize: 14, lineHeight: 18 },
  empty: { alignItems: "center", gap: 8, paddingVertical: 32, paddingHorizontal: 20 },
  emptyTitle: { fontSize: 15, fontWeight: "600", textAlign: "center" },
  emptyHint: { fontSize: 13, lineHeight: 18, textAlign: "center" },
})
