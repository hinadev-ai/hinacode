import type { ProviderId } from "@shared/agent.ts"
import type { ThreadStatus } from "@shared/domain.ts"
import type { ReactNode } from "react"
import { ActivityIndicator, Pressable, type PressableProps, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { HIT, type Palette, radius } from "@/constants/theme"
import { threadStatus } from "@/constants/thread-status"
import { useTheme } from "@/hooks/use-theme"
import type { ConnectionStatus } from "@/lib/connection"

type Variant = "primary" | "secondary" | "danger" | "ghost"

const PRESSED = [{ scale: 0.96 }]

export function Button({
  label,
  icon,
  variant = "secondary",
  busy = false,
  disabled,
  style,
  ...props
}: Omit<PressableProps, "children"> & { label: string; icon?: IconName; variant?: Variant; busy?: boolean }) {
  const theme = useTheme()
  const colors = buttonColors(theme)[variant]
  const inactive = disabled === true || busy
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      style={(state) => [
        styles.button,
        {
          backgroundColor: colors.bg,
          borderColor: colors.border,
          opacity: inactive ? 0.5 : 1,
          transform: state.pressed ? PRESSED : [],
        },
        typeof style === "function" ? style(state) : style,
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
    </Pressable>
  )
}

export function IconButton({
  icon,
  variant = "ghost",
  disabled,
  style,
  ...props
}: Omit<PressableProps, "children" | "accessibilityLabel"> & {
  icon: IconName
  accessibilityLabel: string
  variant?: Variant
}) {
  const theme = useTheme()
  const colors = buttonColors(theme)[variant]
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      style={(state) => [
        styles.iconButton,
        {
          backgroundColor: colors.bg,
          borderColor: colors.border,
          opacity: disabled === true ? 0.5 : 1,
          transform: state.pressed ? PRESSED : [],
        },
        typeof style === "function" ? style(state) : style,
      ]}
      {...props}
    >
      <Icon name={icon} size={20} color={colors.fg} />
    </Pressable>
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
      {icon !== undefined && <Icon name={icon} size={12} color={fg} />}
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

const styles = StyleSheet.create({
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
