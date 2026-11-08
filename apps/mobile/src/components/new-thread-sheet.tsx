import type { Project } from "@shared/domain.ts"
import { router } from "expo-router"
import { type ReactNode, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { PressableScale, Spinner } from "@/components/motion"
import { GroupedCard } from "@/components/grouped-card"
import { OptionRow, Sheet, sheetStyles } from "@/components/sheet"
import { Notice } from "@/components/ui"
import { HIT, mono, radius } from "@/constants/theme"
import { serverName } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { openThread } from "@/lib/navigation"
import { groupByRepository, projectsByActivity } from "@/lib/projects"
import { createThread } from "@/lib/start-thread"
import { useDrafts } from "@/stores/drafts"
import { listedThreads, useThreads } from "@/stores/threads"

type Picking = "project" | "machine" | null

/**
 * Starts a thread: a prompt, the project and, for a repository checked out on several servers, the machine. Start
 * opens the project's draft with the prompt in its composer, where the agent, branch and access wait to be picked
 * before the first message. The most recently active project comes first. `draft` starts the prompt with that text;
 * `title` and `header` say what the thread is for.
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
  const theme = useTheme()
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  const servers = useConnection((state) => state.servers)
  const groups = groupByRepository(projectsByActivity(projects, listedThreads(byId)))
  const [picked, setPicked] = useState<string | null>(null)
  const [picking, setPicking] = useState<Picking>(null)
  const [typed, setTyped] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const serverOf = (project: Project) => servers.find((server) => server.id === project.environmentId)
  const connected = (project: Project) => serverOf(project)?.status === "connected"

  const group = groups.find((candidate) => candidate.some((member) => member.id === picked)) ?? groups[0]
  const project =
    group?.find((member) => member.id === picked) ?? group?.find(connected) ?? (group === undefined ? undefined : group[0])
  const server = project === undefined ? undefined : serverOf(project)
  const prompt = typed ?? draft ?? ""

  const close = () => {
    setError(null)
    setPicking(null)
    setTyped(null)
    onClose()
  }

  const start = async () => {
    if (project === undefined) return
    setCreating(true)
    setError(null)
    try {
      const thread = await createThread(project)
      if (prompt.trim() !== "") useDrafts.getState().setText(thread.id, prompt)
      close()
      openThread(thread.id)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setCreating(false)
    }
  }

  const addProject = () => {
    close()
    router.push({ pathname: "/project/new", params: prompt.trim() === "" ? {} : { draft: prompt } })
  }

  const pick = (next: Project) => {
    setPicked(next.id)
    setPicking(null)
  }

  if (picking !== null) {
    return (
      <Sheet
        title={picking === "project" ? copy("mobile_new_thread_project") : copy("mobile_new_thread_machine")}
        open={open}
        onClose={close}
        fit
      >
        <View role="radiogroup">
          <GroupedCard inset={16}>
            {picking === "project"
              ? groups.map((candidate) => {
                  const first = candidate[0]!
                  return (
                    <OptionRow
                      key={first.id}
                      label={first.name}
                      hint={
                        candidate.length > 1
                          ? copy("mobile_home_project_servers", {
                              servers: candidate
                                .flatMap((member) => serverOf(member) ?? [])
                                .map(serverName)
                                .join(", "),
                            })
                          : first.rootPath
                      }
                      icon="Folder"
                      selected={candidate === group}
                      onPress={() => pick(candidate.find(connected) ?? first)}
                    />
                  )
                })
              : (group ?? []).map((member) => {
                  const memberServer = serverOf(member)
                  return (
                    <OptionRow
                      key={member.id}
                      label={memberServer === undefined ? member.name : serverName(memberServer)}
                      hint={member.rootPath}
                      icon={connected(member) ? "Computer" : "CloudOff"}
                      selected={member === project}
                      disabled={!connected(member)}
                      onPress={() => pick(member)}
                    />
                  )
                })}
          </GroupedCard>
        </View>
        {picking === "project" && (
          <GroupedCard inset={16}>
            <Pressable
              testID="new-thread-add-project"
              accessibilityRole="button"
              accessibilityLabel={copy("mobile_home_add_project")}
              accessibilityHint={copy("mobile_home_add_project_hint")}
              onPress={addProject}
              style={({ pressed }) => [sheetStyles.option, pressed && { backgroundColor: theme.sheetRaised }]}
            >
              <Icon name="FolderAdd" size={18} color={theme.text} />
              <View style={sheetStyles.optionText}>
                <Text style={[sheetStyles.optionLabel, { color: theme.text }]}>{copy("mobile_home_add_project")}</Text>
                <Text style={[sheetStyles.optionHint, { color: theme.textMuted }]}>
                  {copy("mobile_home_add_project_hint")}
                </Text>
              </View>
            </Pressable>
          </GroupedCard>
        )}
      </Sheet>
    )
  }

  const ready = project !== undefined && connected(project)
  return (
    <Sheet
      title={title}
      open={open}
      onClose={close}
      header={header}
      fit
      action={
        <PressableScale
          testID="new-thread-start"
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_new_thread_start")}
          aria-busy={creating}
          aria-disabled={!ready || creating}
          disabled={!ready || creating}
          onPress={() => void start()}
          style={[styles.start, { backgroundColor: ready ? theme.primary : theme.disabled }]}
        >
          {creating ? (
            <Spinner size={18} color={theme.onPrimary} />
          ) : (
            <Icon name="ArrowRight" size={20} color={ready ? theme.onPrimary : theme.textMuted} />
          )}
        </PressableScale>
      }
    >
      {error !== null && <Notice text={error} tone="danger" />}
      <View style={[styles.prompt, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <TextInput
          testID="new-thread-prompt"
          accessibilityLabel={copy("mobile_new_thread_prompt")}
          value={prompt}
          onChangeText={setTyped}
          placeholder={copy("mobile_new_thread_prompt")}
          placeholderTextColor={theme.textMuted}
          multiline
          style={[styles.promptInput, { color: theme.text }]}
        />
      </View>
      {project === undefined ? (
        <GroupedCard inset={16}>
          <Pressable
            testID="new-thread-add-project"
            accessibilityRole="button"
            accessibilityLabel={copy("mobile_home_add_project")}
            onPress={addProject}
            style={({ pressed }) => [sheetStyles.option, pressed && { backgroundColor: theme.sheetRaised }]}
          >
            <Icon name="FolderAdd" size={20} color={theme.text} />
            <Text style={[sheetStyles.optionLabel, styles.flex, { color: theme.text }]}>
              {copy("mobile_home_add_project")}
            </Text>
            <Icon name="ChevronRight" size={18} color={theme.textMuted} />
          </Pressable>
        </GroupedCard>
      ) : (
        <GroupedCard inset={16}>
          {group !== undefined && group.length > 1 && (
            <ValueRow
              testID="new-thread-machine"
              icon="Computer"
              label={copy("mobile_new_thread_machine")}
              value={server === undefined ? project.name : serverName(server)}
              dot={connected(project) ? theme.running : theme.textMuted}
              onPress={() => setPicking("machine")}
            />
          )}
          <ValueRow
            testID="new-thread-project"
            icon="Folder"
            label={copy("mobile_new_thread_project")}
            value={project.name}
            onPress={() => setPicking("project")}
          />
        </GroupedCard>
      )}
    </Sheet>
  )
}

/** A setting's name on the left and its value on the right, opening the choices for it. */
function ValueRow({
  testID,
  icon,
  label,
  value,
  dot,
  onPress,
}: {
  testID: string
  icon: IconName
  label: string
  value: string
  dot?: string
  onPress: () => void
}) {
  const theme = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={{ text: value }}
      onPress={onPress}
      style={({ pressed }) => [sheetStyles.option, pressed && { backgroundColor: theme.sheetRaised }]}
    >
      <Icon name={icon} size={20} color={theme.text} />
      <Text style={[sheetStyles.optionLabel, { color: theme.text }]}>{label}</Text>
      <View style={styles.value}>
        {dot !== undefined && <View style={[styles.dot, { backgroundColor: dot }]} />}
        <Text numberOfLines={1} style={[styles.valueText, { color: theme.textMuted }]}>
          {value}
        </Text>
      </View>
      <Icon name="ChevronRight" size={18} color={theme.textMuted} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  start: { width: HIT, height: HIT, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  prompt: { borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  promptInput: { minHeight: 72, maxHeight: 180, fontSize: 17, lineHeight: 24, padding: 0, textAlignVertical: "top" },
  value: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: radius.full },
  valueText: { flexShrink: 1, fontFamily: mono, fontSize: 14 },
})
