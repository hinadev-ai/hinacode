import type { Project, Thread } from "@shared/domain.ts"
import { router } from "expo-router"
import { type ReactNode, useEffect, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { SettingsSheet, useSettingsSummary } from "@/components/composer"
import { Icon, type IconName } from "@/components/icon"
import { PressableScale, Spinner } from "@/components/motion"
import { GroupedCard } from "@/components/grouped-card"
import { OptionRow, Sheet, sheetStyles } from "@/components/sheet"
import { Notice, ProviderMark } from "@/components/ui"
import { useWorkspace, WorkspaceSheet } from "@/components/workspace-picker"
import { HIT, mono, radius } from "@/constants/theme"
import { serverName } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { refIcon } from "@/lib/workspace-ref"
import { errorText } from "@/lib/error-text"
import { openThread } from "@/lib/navigation"
import { projectsByActivity } from "@/lib/projects"
import { createThread } from "@/lib/start-thread"
import { useDrafts } from "@/stores/drafts"
import { useModels } from "@/stores/models"
import { draftThread, listedThreads, useThreads } from "@/stores/threads"

type Picking = "environment" | "project" | null

/**
 * The picked project's draft, opened as soon as the sheet shows it so the agent, model and branch can be set before
 * Start. The server keeps one draft per project, so opening it again returns the same thread.
 */
function useProjectDraft(project: Project | undefined, open: boolean, onError: (message: string) => void) {
  const connected = useConnection((state) => state.status === "connected")
  const [draftIds, setDraftIds] = useState<Record<string, string>>({})
  const projectId = project?.id
  const draftId = projectId === undefined ? undefined : draftIds[projectId]
  const draft = useThreads((state) => draftThread(state.byId, draftId))
  const hasDraft = draft !== undefined

  useEffect(() => {
    if (!open || !connected || project === undefined || hasDraft) return
    let current = true
    createThread(project).then(
      (thread) => current && setDraftIds((ids) => ({ ...ids, [project.id]: thread.id })),
      (cause: unknown) => current && onError(errorText(cause)),
    )
    return () => {
      current = false
    }
  }, [open, connected, project, hasDraft, onError])

  const server = project?.environmentId
  const provider = draft?.provider
  useEffect(() => {
    if (!connected || provider === undefined) return
    useModels
      .getState()
      .load(server, provider)
      .catch((cause: unknown) => onError(errorText(cause)))
  }, [connected, server, provider, onError])

  return draft
}

/**
 * Starts a thread: a prompt, the environment it runs on, one of that environment's projects, and the agent, model and
 * branch of that project's draft. Start opens the draft with the prompt in its composer. The most recently active
 * project comes first. `draft` starts the prompt with that text; `title` and `header` say what the thread is for.
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
  const byActivity = projectsByActivity(projects, listedThreads(byId))
  const [pickedProject, setPickedProject] = useState<string | null>(null)
  const [pickedServer, setPickedServer] = useState<string | null>(null)
  const [picking, setPicking] = useState<Picking>(null)
  const [typed, setTyped] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isConnected = (serverId: string | undefined) => servers.some((server) => server.id === serverId && server.status === "connected")

  const server =
    servers.find((candidate) => candidate.id === pickedServer) ??
    servers.find((candidate) => candidate.id === byActivity.find((item) => isConnected(item.environmentId))?.environmentId) ??
    servers[0]
  const serverProjects = byActivity.filter((item) => item.environmentId === server?.id)
  const project = serverProjects.find((item) => item.id === pickedProject) ?? serverProjects[0]
  const prompt = typed ?? draft ?? ""
  const projectDraft = useProjectDraft(project, open, setError)

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
      const thread = projectDraft ?? (await createThread(project))
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

  const pickProject = (next: Project) => {
    setPickedProject(next.id)
    setPicking(null)
  }

  const pickServer = (serverId: string) => {
    setPickedServer(serverId)
    setPickedProject(null)
    setPicking(null)
  }

  if (picking !== null) {
    return (
      <Sheet
        title={picking === "project" ? copy("mobile_new_thread_project") : copy("mobile_new_thread_environment")}
        open={open}
        onClose={close}
        fit
      >
        <View role="radiogroup">
          <GroupedCard inset={16}>
            {picking === "project"
              ? serverProjects.map((candidate) => (
                  <OptionRow
                    key={candidate.id}
                    label={candidate.name}
                    hint={server === undefined ? undefined : serverName(server)}
                    icon="Folder"
                    selected={candidate === project}
                    onPress={() => pickProject(candidate)}
                  />
                ))
              : servers.map((candidate) => (
                  <OptionRow
                    key={candidate.id}
                    label={serverName(candidate)}
                    hint={copy("mobile_new_thread_environment_projects", {
                      count: String(byActivity.filter((item) => item.environmentId === candidate.id).length),
                    })}
                    icon={candidate.status === "connected" ? "Computer" : "CloudOff"}
                    selected={candidate === server}
                    disabled={candidate.status !== "connected"}
                    onPress={() => pickServer(candidate.id)}
                  />
                ))}
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

  const ready = project !== undefined && isConnected(project.environmentId)
  return (
    <Sheet
      title={title}
      open={open}
      onClose={close}
      header={header}
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
      <GroupedCard inset={16}>
        {server !== undefined && (
          <ValueRow
            testID="new-thread-environment"
            icon="Computer"
            label={copy("mobile_new_thread_environment")}
            value={serverName(server)}
            dot={server.status === "connected" ? theme.running : theme.textMuted}
            onPress={() => setPicking("environment")}
          />
        )}
        {project === undefined ? (
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
        ) : (
          <ValueRow
            testID="new-thread-project"
            icon="Folder"
            label={copy("mobile_new_thread_project")}
            value={project.name}
            onPress={() => setPicking("project")}
          />
        )}
      </GroupedCard>
      {projectDraft !== undefined && <DraftSettings thread={projectDraft} onError={setError} />}
    </Sheet>
  )
}

/** The draft's agent and model, and the branch its first message runs on, each opening the composer's own picker. */
function DraftSettings({ thread, onError }: { thread: Thread; onError: (message: string) => void }) {
  const [open, setOpen] = useState<"settings" | "workspace" | null>(null)
  const { providerLabel, modelLabel, effortText } = useSettingsSummary(thread)
  const workspace = useWorkspace(thread)
  const close = () => setOpen(null)
  return (
    <>
      <GroupedCard inset={16}>
        <ValueRow
          testID="new-thread-agent"
          leading={<ProviderMark provider={thread.provider} size={20} />}
          label={providerLabel}
          value={effortText === null ? modelLabel : `${modelLabel} · ${effortText}`}
          onPress={() => setOpen("settings")}
        />
        <ValueRow
          testID="new-thread-workspace"
          icon={refIcon(workspace.ref)}
          label={copy(workspace.mode === "worktree" ? "mobile_workspace_new_worktree" : "mobile_workspace_title")}
          value={workspace.label}
          onPress={() => setOpen("workspace")}
        />
      </GroupedCard>
      <SettingsSheet thread={thread} open={open === "settings"} onClose={close} onError={onError} isNew />
      <WorkspaceSheet
        thread={thread}
        workspace={{ mode: workspace.mode, ref: workspace.ref }}
        open={open === "workspace"}
        onClose={close}
        onError={onError}
      />
    </>
  )
}

/** A setting's name on the left and its value on the right, opening the choices for it. */
function ValueRow({
  testID,
  icon,
  leading,
  label,
  value,
  dot,
  onPress,
}: {
  testID: string
  icon?: IconName
  leading?: ReactNode
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
      {leading ?? (icon !== undefined && <Icon name={icon} size={20} color={theme.text} />)}
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
  promptInput: { minHeight: 140, maxHeight: 280, fontSize: 17, lineHeight: 24, padding: 0, textAlignVertical: "top" },
  value: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: radius.full },
  valueText: { flexShrink: 1, fontFamily: mono, fontSize: 14 },
})
