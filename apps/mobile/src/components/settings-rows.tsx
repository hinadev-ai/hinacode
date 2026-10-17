import { Children, Fragment, type ReactNode } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { Toggle } from "@/components/ui"
import { HIT, mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"

/** An inset group of rows with a small header above it and an optional footnote under it. */
export function SettingsGroup({
  title,
  footnote,
  children,
}: {
  title: string
  footnote?: ReactNode
  children: ReactNode
}) {
  const theme = useTheme()
  const rows = Children.toArray(children)
  return (
    <View style={styles.group}>
      <Text accessibilityRole="header" style={[styles.groupTitle, { color: theme.textMuted }]}>
        {title}
      </Text>
      <View style={[styles.rows, { backgroundColor: theme.surface }]}>
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 && <View style={[styles.separator, { backgroundColor: theme.border }]} />}
            {row}
          </Fragment>
        ))}
      </View>
      {footnote !== undefined && <Footnote text={footnote} />}
    </View>
  )
}

export function Footnote({ text }: { text: ReactNode }) {
  const theme = useTheme()
  return <Text style={[styles.footnote, { color: theme.textMuted }]}>{text}</Text>
}

/** A row with a leading icon, a label and a trailing control or value. Pressable when `onPress` is given. */
export function SettingsRow({
  icon,
  label,
  value,
  monospace = false,
  disabled = false,
  onPress,
  children,
}: {
  icon?: IconName
  label: string
  /** Muted text at the trailing edge, such as the current choice. */
  value?: string
  monospace?: boolean
  disabled?: boolean
  onPress?: () => void
  /** A trailing control such as a `Switch`. */
  children?: ReactNode
}) {
  const theme = useTheme()
  const content = (
    <>
      {icon !== undefined && <Icon name={icon} size={18} color={theme.textMuted} />}
      <Text style={[styles.label, { color: disabled ? theme.textMuted : theme.text }]}>{label}</Text>
      {value !== undefined && (
        <Text numberOfLines={1} style={[styles.value, monospace && styles.mono, { color: theme.textMuted }]}>
          {value}
        </Text>
      )}
      {children}
      {onPress !== undefined && <Icon name="RiArrowRightSLine" size={18} color={theme.textMuted} />}
    </>
  )
  if (onPress === undefined) return <View style={styles.row}>{content}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={value !== undefined ? { text: value } : undefined}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surfaceStrong }]}
    >
      {content}
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
      <Toggle
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ checked: value, disabled }}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
      />
    </SettingsRow>
  )
}

const styles = StyleSheet.create({
  group: { gap: 6 },
  groupTitle: { fontSize: 13, fontWeight: "600", paddingHorizontal: 16 },
  rows: { borderRadius: radius.lg, overflow: "hidden" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 46 },
  row: {
    minHeight: HIT,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  label: { flex: 1, fontSize: 15 },
  value: { flexShrink: 1, maxWidth: "50%", fontSize: 15, textAlign: "right" },
  mono: { fontFamily: mono, fontSize: 14 },
  footnote: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16 },
})
