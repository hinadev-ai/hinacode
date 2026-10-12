import type { ThreadStatus } from "@shared/domain.ts"
import { ActivityIndicator, Pressable, type PressableProps, StyleSheet, Text, View } from "react-native"
import { HIT, type Palette } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import type { ConnectionStatus } from "@/lib/connection"

type Variant = "primary" | "secondary" | "danger" | "ghost"

export function Button({
  label,
  variant = "secondary",
  busy = false,
  disabled,
  style,
  ...props
}: Omit<PressableProps, "children"> & { label: string; variant?: Variant; busy?: boolean }) {
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
        { backgroundColor: colors.bg, borderColor: colors.border, opacity: inactive ? 0.5 : state.pressed ? 0.8 : 1 },
        typeof style === "function" ? style(state) : style,
      ]}
      {...props}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.fg} />
      ) : (
        <Text style={[styles.buttonLabel, { color: colors.fg }]}>{label}</Text>
      )}
    </Pressable>
  )
}

const buttonColors = (theme: Palette) => ({
  primary: { bg: theme.primary, fg: theme.onPrimary, border: theme.primary },
  secondary: { bg: theme.surface, fg: theme.text, border: theme.border },
  danger: { bg: theme.dangerBg, fg: theme.danger, border: theme.dangerBg },
  ghost: { bg: "transparent", fg: theme.text, border: "transparent" },
})

type Tone = "neutral" | "attention" | "running" | "danger"

export function Pill({ label, tone }: { label: string; tone: Tone }) {
  const theme = useTheme()
  const [fg, bg] = toneColors(theme)[tone]
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
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

const threadStatus: Record<ThreadStatus, { label: string; tone: Tone }> = {
  idle: { label: "Idle", tone: "neutral" },
  running: { label: "Running", tone: "running" },
  awaiting_approval: { label: "Needs you", tone: "attention" },
  limited: { label: "Limited", tone: "attention" },
  settled: { label: "Settled", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
}

export const threadStatusLabel = (status: ThreadStatus) => threadStatus[status].label

export const ThreadStatusPill = ({ status }: { status: ThreadStatus }) => <Pill {...threadStatus[status]} />

const connectionLabel: Record<ConnectionStatus, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "running" },
  connecting: { label: "Connecting", tone: "neutral" },
  offline: { label: "Reconnecting", tone: "attention" },
  unauthorized: { label: "Not paired", tone: "danger" },
}

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const { label, tone } = connectionLabel[status]
  return (
    <View accessibilityRole="text" accessibilityLabel={`Connection: ${label}`} testID="connection-status">
      <Pill label={label} tone={tone} />
    </View>
  )
}

export function Notice({ text, tone = "neutral" }: { text: string; tone?: Tone }) {
  const theme = useTheme()
  const [fg, bg] = toneColors(theme)[tone]
  return (
    <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 14 }}>{text}</Text>
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
    alignItems: "center",
    justifyContent: "center",
  },
  buttonLabel: { fontSize: 15, fontWeight: "600" },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: "flex-start" },
  pillLabel: { fontSize: 12, fontWeight: "600" },
  notice: { borderRadius: 8, padding: 12 },
})
