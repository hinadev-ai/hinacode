import { NativeTabs } from "expo-router/native-tabs"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Icon } from "@/components/icon"
import { mono, radius } from "@/constants/theme"
import { useProjectServer } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { projectsByActivity } from "@/lib/projects"
import { listedThreads, useThreads } from "@/stores/threads"

/**
 * Start a new thread as the iOS 26 tab bar's bottom accessory. The system draws the glass and renders a second copy
 * inline when the tab bar minimizes, so the sheet's state lives with the caller.
 */
export function NewThreadAccessory({ onPress }: { onPress: () => void }) {
  const inline = NativeTabs.BottomAccessory.usePlacement() === "inline"
  return <AccessoryPill placement={inline ? "inline" : "regular"} onPress={onPress} />
}

/** The same pill on its own surface, floating above the tab bar where the system has no accessory. */
export function FloatingNewThreadAccessory({ onPress }: { onPress: () => void }) {
  const theme = useTheme()
  return (
    <SafeAreaView edges={["bottom"]} pointerEvents="box-none" style={styles.floating}>
      <View style={[styles.surface, { backgroundColor: theme.background }]}>
        <AccessoryPill placement="floating" onPress={onPress} />
      </View>
    </SafeAreaView>
  )
}

/** The project a new thread most likely belongs to: the one with the latest activity, as the new thread sheet lists. */
function useDefaultProject() {
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  return projectsByActivity(projects, listedThreads(byId))[0]
}

function AccessoryPill({
  placement,
  onPress,
}: {
  placement: "regular" | "inline" | "floating"
  onPress: () => void
}) {
  const theme = useTheme()
  const inline = placement === "inline"
  const project = useDefaultProject()
  const server = useProjectServer(project?.id)
  return (
    <Pressable
      testID="new-thread-accessory"
      accessibilityRole="button"
      accessibilityLabel={copy("mobile_home_new_thread")}
      accessibilityHint={project?.name}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        inline && styles.inline,
        placement === "floating" && styles.floatingPill,
        pressed && styles.pressed,
      ]}
    >
      <Text numberOfLines={1} style={[styles.placeholder, inline && styles.inlineText, { color: theme.textMuted }]}>
        {copy("mobile_home_start_thread")}
      </Text>
      {project !== undefined && !inline && (
        <View style={styles.project}>
          <View
            style={[
              styles.dot,
              { backgroundColor: server?.status === "connected" ? theme.running : theme.textMuted },
            ]}
          />
          <Text numberOfLines={1} style={[styles.projectName, { color: theme.textMuted }]}>
            {project.name}
          </Text>
        </View>
      )}
      <View style={[styles.plus, inline && styles.inlinePlus, { backgroundColor: theme.primary }]}>
        <Icon name="Plus" size={inline ? 16 : 20} color={theme.onPrimary} />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  floating: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingBottom: 8 },
  surface: { borderRadius: radius.full, boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)" },
  pill: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 20, paddingRight: 4 },
  inline: { gap: 8, paddingLeft: 16 },
  floatingPill: { minHeight: 52, paddingRight: 6 },
  pressed: { opacity: 0.7 },
  placeholder: { flex: 1, fontSize: 17 },
  inlineText: { fontSize: 15 },
  project: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, maxWidth: "45%" },
  dot: { width: 8, height: 8, borderRadius: radius.full },
  projectName: { flexShrink: 1, fontFamily: mono, fontSize: 14 },
  plus: { width: 40, height: 40, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  inlinePlus: { width: 28, height: 28 },
})
