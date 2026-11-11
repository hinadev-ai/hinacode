import { router, useSegments } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { GlassFill, liquidGlass } from "@/components/glass"
import { HomeActionsSheet } from "@/components/home-header"
import { Icon, type IconName } from "@/components/icon"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { radius } from "@/constants/theme"
import { useSideRail } from "@/hooks/use-side-rail"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

const STATUS_CLEARANCE = 168
const BUTTON_SIZE = 48

export function SideRail() {
  const width = useSideRail()
  const insets = useSafeAreaInsets()
  const segments: readonly string[] = useSegments()
  const [open, setOpen] = useState<"actions" | "new-thread" | null>(null)
  if (width === 0 || segments[0] !== "(tabs)") return null
  const onThreads = segments[1] === "(threads)"
  const close = () => setOpen(null)
  return (
    <>
      {onThreads && (
        <View pointerEvents="box-none" style={[styles.column, { width, top: STATUS_CLEARANCE }]}>
          <RailButton testID="rail-more" icon="More" label={copy("mobile_home_more")} onPress={() => setOpen("actions")} />
        </View>
      )}
      <View pointerEvents="box-none" style={[styles.column, { width, bottom: insets.bottom }]}>
        {onThreads && (
          <RailButton
            testID="rail-new-thread"
            icon="Plus"
            label={copy("mobile_home_new_thread")}
            primary
            onPress={() => setOpen("new-thread")}
          />
        )}
        <RailButton testID="rail-search" icon="Search" label={copy("mobile_search_title")} onPress={() => router.push("/find")} />
      </View>
      <HomeActionsSheet open={open === "actions"} onClose={close} />
      <NewThreadSheet open={open === "new-thread"} onClose={close} />
    </>
  )
}

function RailButton({
  testID,
  icon,
  label,
  primary = false,
  onPress,
}: {
  testID: string
  icon: IconName
  label: string
  primary?: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary
          ? { backgroundColor: theme.primary }
          : liquidGlass
            ? styles.glass
            : { backgroundColor: theme.card, borderColor: theme.border, borderWidth: StyleSheet.hairlineWidth },
        pressed && styles.pressed,
      ]}
    >
      {!primary && <GlassFill />}
      <Icon name={icon} size={primary ? 24 : 20} color={primary ? theme.onPrimary : theme.text} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  column: { position: "absolute", right: 0, alignItems: "center", gap: 12 },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.16)",
  },
  glass: { overflow: "hidden" },
  pressed: { transform: [{ scale: 0.94 }] },
})
