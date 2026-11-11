import type { ReactNode } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { GroupedCard } from "@/components/grouped-card"
import { Icon, type IconName } from "@/components/icon"
import { Toggle } from "@/components/ui"
import { HIT, mono, radius, subheading } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"

const ROW_PADDING = 16
const TILE = 30
const ROW_GAP = 12
const SEPARATOR_INSET = ROW_PADDING + TILE + ROW_GAP

export function SettingsGroup({
  title,
  footnote,
  children,
}: {
  title?: string
  footnote?: ReactNode
  children: ReactNode
}) {
  return (
    <View style={styles.group}>
      {title !== undefined && <SettingsHeading title={title} />}
      <GroupedCard inset={SEPARATOR_INSET}>{children}</GroupedCard>
      {footnote !== undefined && <Footnote text={footnote} />}
    </View>
  )
}

export function SettingsHeading({ title }: { title: string }) {
  const theme = useTheme()
  return (
    <Text accessibilityRole="header" {...subheading} style={[styles.groupTitle, { color: theme.textMuted }]}>
      {title}
    </Text>
  )
}

export function Footnote({ text }: { text: ReactNode }) {
  const theme = useTheme()
  return <Text style={[styles.footnote, { color: theme.textMuted }]}>{text}</Text>
}

export function IconTile({ icon, color }: { icon: IconName; color?: string }) {
  const theme = useTheme()
  return (
    <View style={[styles.tile, { backgroundColor: theme.surface }]}>
      <Icon name={icon} size={17} color={color ?? theme.text} />
    </View>
  )
}

export function SettingsRow({
  icon,
  iconColor,
  label,
  value,
  monospace = false,
  disabled = false,
  labelLines,
  onPress,
  children,
}: {
  icon?: IconName
  iconColor?: string
  label: string
  labelLines?: number
  value?: string
  monospace?: boolean
  disabled?: boolean
  onPress?: () => void
  children?: ReactNode
}) {
  const theme = useTheme()
  const content = (
    <>
      {icon !== undefined && <IconTile icon={icon} color={disabled ? theme.textMuted : iconColor} />}
      <Text numberOfLines={labelLines} style={[styles.label, { color: disabled ? theme.textMuted : theme.text }]}>
        {label}
      </Text>
      {value !== undefined && (
        <Text numberOfLines={1} style={[styles.value, monospace && styles.mono, { color: theme.textMuted }]}>
          {value}
        </Text>
      )}
      {children}
      {onPress !== undefined && <Icon name="ChevronRight" size={18} color={theme.textMuted} />}
    </>
  )
  if (onPress === undefined) return <View style={styles.row}>{content}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={value !== undefined ? { text: value } : undefined}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
    >
      {content}
    </Pressable>
  )
}

export function CheckRow({
  icon,
  label,
  hint,
  color,
  selected,
  disabled = false,
  onPress,
}: {
  icon?: IconName
  label: string
  hint?: string
  color?: string
  selected: boolean
  disabled?: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={hint}
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
    >
      {icon !== undefined && <IconTile icon={icon} color={disabled ? theme.textMuted : color} />}
      <Text style={[styles.label, { color: disabled ? theme.textMuted : theme.text }]}>{label}</Text>
      {selected && <Icon name="Check" size={20} color={disabled ? theme.textMuted : theme.primary} />}
    </Pressable>
  )
}

export function SwitchRow({
  icon,
  label,
  value,
  disabled = false,
  onChange,
}: {
  icon?: IconName
  label: string
  value: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <SettingsRow icon={icon} label={label} disabled={disabled}>
      <Toggle accessibilityLabel={label} value={value} disabled={disabled} onValueChange={onChange} />
    </SettingsRow>
  )
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  groupTitle: { fontSize: 13, fontWeight: "600", paddingHorizontal: 8 },
  tile: {
    width: TILE,
    height: TILE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm + 2,
  },
  row: {
    minHeight: HIT + 8,
    flexDirection: "row",
    alignItems: "center",
    gap: ROW_GAP,
    paddingHorizontal: ROW_PADDING,
    paddingVertical: 8,
  },
  label: { flex: 1, fontSize: 16 },
  value: { flexShrink: 1, maxWidth: "50%", fontSize: 15, textAlign: "right" },
  mono: { fontFamily: mono, fontSize: 14 },
  footnote: { fontSize: 13, lineHeight: 18, paddingHorizontal: 8 },
})
