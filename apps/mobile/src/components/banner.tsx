import { useEffect, useState } from "react"
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon, type IconName } from "@/components/icon"
import { Button, IconButton } from "@/components/ui"
import { duration } from "@/constants/motion"
import { HIT, type Palette, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { motion } from "@/lib/motion"
import type { AlertKind } from "@/lib/thread-alerts"

export interface BannerNotice {
  /** Changes with every alert, so a newer one replaces the shown banner even for the same thread. */
  readonly id: number
  readonly threadId: string
  readonly kind: AlertKind
  readonly title: string
  readonly body: string
}

/** A request or a failure waits for the developer, so it outlasts a plain "finished". */
const visibleMs: Record<AlertKind, number> = { completed: 4_000, needsInput: 10_000, failed: 10_000 }

const icons: Record<AlertKind, { name: IconName; color: keyof Palette }> = {
  completed: { name: "RiCheckboxCircleLine", color: "running" },
  needsInput: { name: "RiErrorWarningLine", color: "attention" },
  failed: { name: "RiErrorWarningLine", color: "danger" },
}

const RISE = 16

/** One alert at a time, floating at the top of every screen until it times out, is opened or is dismissed. */
export function Banner({
  notice,
  onOpen,
  onDismiss,
}: {
  notice: BannerNotice | null
  onOpen: (threadId: string) => void
  onDismiss: () => void
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.layer, { paddingTop: insets.top + 8 }]}>
      {notice !== null && <Card key={notice.id} notice={notice} onOpen={onOpen} onDismiss={onDismiss} />}
    </View>
  )
}

function Card({
  notice,
  onOpen,
  onDismiss,
}: {
  notice: BannerNotice
  onOpen: (threadId: string) => void
  onDismiss: () => void
}) {
  const theme = useTheme()
  const [held, setHeld] = useState(false)
  const { kind, title, body, threadId } = notice
  const icon = icons[kind]

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(`${title}. ${body}`)
  }, [title, body])

  useEffect(() => {
    if (held) return
    const timer = setTimeout(onDismiss, visibleMs[kind])
    return () => clearTimeout(timer)
  }, [held, kind, onDismiss])

  const open = () => {
    onOpen(threadId)
    onDismiss()
  }

  return (
    <motion.View
      initial={{ opacity: 0, y: -RISE }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -RISE / 2, transition: { duration: duration.fast } }}
      style={[styles.card, { backgroundColor: theme.background, borderColor: theme.border }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${body}`}
        onPress={open}
        onPressIn={() => setHeld(true)}
        onPressOut={() => setHeld(false)}
        style={styles.content}
      >
        <Icon name={icon.name} size={20} color={theme[icon.color]} />
        <View style={styles.text}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
            {title}
          </Text>
          <Text numberOfLines={2} style={[styles.body, { color: theme.textMuted }]}>
            {body}
          </Text>
        </View>
      </Pressable>
      <Button label={copy("mobile_notify_open")} onPress={open} hitSlop={4} style={styles.open} />
      <IconButton icon="RiCloseLine" accessibilityLabel={copy("mobile_notify_dismiss")} onPress={onDismiss} />
    </motion.View>
  )
}

const styles = StyleSheet.create({
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    alignItems: "center",
    paddingHorizontal: 12,
    pointerEvents: "box-none",
  },
  card: {
    width: "100%",
    maxWidth: 560,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 4,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)",
  },
  content: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: HIT, paddingVertical: 4 },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: "600" },
  body: { fontSize: 14, lineHeight: 19 },
  open: { minHeight: 36, paddingHorizontal: 12 },
})
