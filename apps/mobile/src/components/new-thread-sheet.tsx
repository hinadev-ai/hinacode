import type { Project } from "@shared/domain.ts"
import { router } from "expo-router"
import { type ReactNode, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { Spinner } from "@/components/motion"
import { Sheet, sheetStyles } from "@/components/sheet"
import { openThread } from "@/lib/navigation"
import { Notice } from "@/components/ui"
import { serverName } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { groupByRepository, projectsByActivity } from "@/lib/projects"
import { createThread } from "@/lib/start-thread"
import { useDrafts } from "@/stores/drafts"
import { useThreads } from "@/stores/threads"

/**
 * Starts a thread in a project, the most recently active first, or goes on to add a project. A repository checked
 * out on several servers is one row, which asks which server the thread runs on. `draft` starts the new thread's
 * composer with that text; `title` and `header` say what the thread is for.
 */
export function NewThreadSheet({
  open,
  onClose,
  title = copy("mobile_home_new_thread_title"),
  header,
  draft,
}: {
  open: boolean
  onClose: () => void
  title?: string
  header?: ReactNode
  draft?: string
}) {
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  const servers = useConnection((state) => state.servers)
  const groups = groupByRepository(projectsByActivity(projects, Object.values(byId)))
  const [choosing, setChoosing] = useState<readonly Project[] | null>(null)
  const [creating, setCreating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const several = servers.length > 1
  const serverOf = (project: Project) => servers.find((server) => server.id === project.environmentId)
  const where = (project: Project) => {
    const server = serverOf(project)
    return several && server !== undefined
      ? copy("mobile_home_project_on_server", { path: project.rootPath, server: serverName(server) })
      : project.rootPath
  }

  const close = () => {
    setError(null)
    setChoosing(null)
    onClose()
  }

  const create = async (project: Project) => {
    setCreating(project.id)
    setError(null)
    try {
      const thread = await createThread(project)
      if (draft !== undefined) useDrafts.getState().setText(thread.id, draft)
      close()
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

  if (choosing !== null) {
    const name = choosing[0]!.name
    return (
      <Sheet title={copy("mobile_home_new_in_project", { project: name })} open={open} onClose={close} fit>
        {error !== null && <Notice text={error} tone="danger" />}
        <View>
          {choosing.map((project) => {
            const server = serverOf(project)
            const connected = server?.status === "connected"
            return (
              <SheetRow
                key={project.id}
                testID={`new-thread-${project.id}`}
                icon={connected ? "RiComputerLine" : "RiWifiOffLine"}
                label={server === undefined ? name : serverName(server)}
                hint={project.rootPath}
                accessibilityLabel={copy("mobile_home_new_on_server", {
                  project: name,
                  server: server === undefined ? name : serverName(server),
                })}
                busy={creating === project.id}
                disabled={creating !== null || !connected}
                onPress={() => void create(project)}
              />
            )
          })}
          <SheetRow
            testID="new-thread-back"
            icon="RiArrowLeftSLine"
            label={copy("mobile_home_new_thread_back")}
            hint={copy("mobile_home_new_thread_back_hint")}
            accessibilityLabel={copy("mobile_home_new_thread_back")}
            busy={false}
            disabled={creating !== null}
            onPress={() => setChoosing(null)}
          />
        </View>
      </Sheet>
    )
  }

  return (
    <Sheet title={title} open={open} onClose={close} header={header} fit>
      {error !== null && <Notice text={error} tone="danger" />}
      <View>
        {groups.map((group) => {
          const project = group[0]!
          const spread = group.length > 1
          return (
            <SheetRow
              key={project.id}
              testID={`new-thread-${project.id}`}
              icon="RiFolderLine"
              label={project.name}
              hint={
                spread
                  ? copy("mobile_home_project_servers", {
                      servers: group
                        .flatMap((member) => serverOf(member) ?? [])
                        .map(serverName)
                        .join(", "),
                    })
                  : where(project)
              }
              accessibilityLabel={copy("mobile_home_new_in_project", { project: project.name })}
              busy={creating === project.id}
              disabled={creating !== null}
              onPress={() => (spread ? setChoosing(group) : void create(project))}
            />
          )
        })}
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
      aria-busy={busy}
      aria-disabled={disabled}
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
