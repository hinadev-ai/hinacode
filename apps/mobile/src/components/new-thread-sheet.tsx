import type { Project } from "@shared/domain.ts"
import { router } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { Spinner } from "@/components/motion"
import { Sheet, sheetStyles } from "@/components/sheet"
import { openThread } from "@/components/thread-row"
import { Notice } from "@/components/ui"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { projectsByActivity } from "@/lib/projects"
import { useThreads } from "@/stores/threads"

/** Starts a thread in a project, the most recently active first, or goes on to add a project. */
export function NewThreadSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  const ordered = projectsByActivity(projects, Object.values(byId))
  const [creating, setCreating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setError(null)
    onClose()
  }

  const create = async (project: Project) => {
    setCreating(project.id)
    setError(null)
    try {
      const thread = await call("threads.create", { projectId: project.id })
      useThreads.getState().upsert(thread)
      onClose()
      openThread(thread.id)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setCreating(null)
    }
  }

  const addProject = () => {
    close()
    router.push("/project/new")
  }

  return (
    <Sheet title={copy("mobile_home_new_thread_title")} open={open} onClose={close}>
      {error !== null && <Notice text={error} tone="danger" />}
      <View>
        {ordered.map((project) => (
          <SheetRow
            key={project.id}
            testID={`new-thread-${project.id}`}
            icon="RiFolderLine"
            label={project.name}
            hint={project.rootPath}
            accessibilityLabel={copy("mobile_home_new_in_project", { project: project.name })}
            busy={creating === project.id}
            disabled={creating !== null}
            onPress={() => void create(project)}
          />
        ))}
        <SheetRow
          testID="new-thread-add-project"
          icon="RiFolderAddLine"
          label={copy("mobile_home_add_project")}
          hint={copy("mobile_home_add_project_hint")}
          accessibilityLabel={copy("mobile_home_add_project")}
          busy={false}
          disabled={creating !== null}
          onPress={addProject}
        />
      </View>
    </Sheet>
  )
}

function SheetRow({
  testID,
  icon,
  label,
  hint,
  accessibilityLabel,
  busy,
  disabled,
  onPress,
}: {
  testID: string
  icon: IconName
  label: string
  hint: string
  accessibilityLabel: string
  busy: boolean
  disabled: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={hint}
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [sheetStyles.option, pressed && { backgroundColor: theme.surface }]}
    >
      <Icon name={icon} size={18} color={theme.text} />
      <View style={sheetStyles.optionText}>
        <Text numberOfLines={1} style={[sheetStyles.optionLabel, { color: theme.text }]}>
          {label}
        </Text>
        <Text numberOfLines={1} ellipsizeMode="head" style={[sheetStyles.optionHint, { color: theme.textMuted }]}>
          {hint}
        </Text>
      </View>
      <View style={styles.trailing}>
        {busy ? (
          <Spinner size={18} color={theme.textMuted} />
        ) : (
          <Icon name="RiArrowRightSLine" size={18} color={theme.textMuted} />
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  trailing: { width: 18, alignItems: "center" },
})
