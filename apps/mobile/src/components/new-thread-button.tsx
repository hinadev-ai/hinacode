import { Pressable, StyleSheet, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Icon } from "@/components/icon"
import { radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { projectsByActivity } from "@/lib/projects"
import { listedThreads, useThreads } from "@/stores/threads"

const SIZE = 56

export function NewThreadButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme()
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  const project = projectsByActivity(projects, listedThreads(byId))[0]
  return (
    <SafeAreaView edges={["bottom"]} pointerEvents="box-none" style={styles.corner}>
      <Pressable
        testID="new-thread-button"
        accessibilityRole="button"
        accessibilityLabel={copy("mobile_home_new_thread")}
        accessibilityHint={project?.name}
        onPress={onPress}
        style={({ pressed }) => [styles.button, { backgroundColor: theme.primary }, pressed && styles.pressed]}
      >
        <View pointerEvents="none">
          <Icon name="Plus" size={26} color={theme.onPrimary} />
        </View>
      </Pressable>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  corner: { position: "absolute", right: 0, bottom: 0, paddingRight: 20, paddingBottom: 16 },
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 6px 16px rgba(0, 0, 0, 0.22), 0 2px 4px rgba(0, 0, 0, 0.12)",
  },
  pressed: { transform: [{ scale: 0.94 }] },
})
