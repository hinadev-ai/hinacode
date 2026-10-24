import { type AgentCommand, type ModelInfo, ProviderId, unlistedModel } from "@shared/agent.ts"
import { completionAt, type Suggestion, suggestionsFor } from "@shared/composerSyntax.ts"
import type { RpcRequest } from "@shared/contract.ts"
import { AccessMode, isThreadBusy, type Thread, toCheckoutTarget } from "@shared/domain.ts"
import { useEffect, useRef, useState } from "react"
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { OptionRow, Section, Sheet, sheetStyles } from "@/components/sheet"
import { Toggle } from "@/components/ui"
import { WorkspaceChip } from "@/components/workspace-picker"
import { HIT, mono, radius } from "@/constants/theme"
import { useThreadServer } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { useDrafts } from "@/stores/drafts"
import { useMessages } from "@/stores/messages"
import { modelsOn, useModels } from "@/stores/models"
import { useThreads } from "@/stores/threads"

type OnError = (message: string) => void

const update = async (patch: RpcRequest<"threads.update">, onError: OnError) => {
  try {
    useThreads.getState().upsert(await call("threads.update", patch))
  } catch (cause) {
    onError(errorText(cause))
  }
}

const LINE_HEIGHT = 20
const INPUT_PADDING = 6
const MAX_LINES = 5
const CHIP_HEIGHT = 32
const SEND_SIZE = 36
const SUGGESTION_HEIGHT = 48
const VISIBLE_SUGGESTIONS = 4.5

/**
 * Where the caret is after an edit: right after the span that changed. react-native-web fires no selection
 * event while typing, so the edit itself is the only signal there.
 */
const caretAfterEdit = (before: string, after: string) => {
  let prefix = 0
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  const maxSuffix = Math.min(before.length, after.length) - prefix
  while (suffix < maxSuffix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  return after.length - suffix
}

/** Agent and workspace stay open to change until the first message, as on the desktop. */
function useUnstarted(thread: Thread) {
  return useMessages((state) => {
    const history = state.byThread[thread.id]
    return history?.status === "ready" && history.messages.length === 0 && thread.worktreeId === null
  })
}

/**
 * What the composer completes: the agent's `/commands` and `$skills`, the workspace's files and the project's
 * other threads. Commands are listed again when the agent, account or worktree changes, and after a turn. The file
 * list can run to megabytes in a large repository, so it is fetched only once an `@` asks for it, and again at the
 * next `@` after the workspace changed or a turn ran.
 */
function useCompletions(thread: Thread, busy: boolean, wantsFiles: boolean, onError: OnError) {
  const connected = useConnection((state) => state.status === "connected")
  const [commands, setCommands] = useState<readonly AgentCommand[]>([])
  const [files, setFiles] = useState<{ readonly key: string; readonly paths: readonly string[] } | null>(null)
  const byId = useThreads((state) => state.byId)
  const filesKey = `${thread.id}|${thread.worktreeId}|${busy}`
  const filesFresh = files?.key === filesKey
  useEffect(() => {
    if (!connected) return
    let current = true
    call("commands.list", { threadId: thread.id }).then(
      (next) => current && setCommands(next),
      (cause: unknown) => current && onError(`Could not list commands: ${errorText(cause)}`),
    )
    return () => {
      current = false
    }
  }, [connected, thread.id, thread.provider, thread.accountId, thread.worktreeId, busy, onError])
  useEffect(() => {
    if (!connected || !wantsFiles || filesFresh) return
    let current = true
    call("files.list", { threadId: thread.id }).then(
      (paths) => current && setFiles({ key: filesKey, paths }),
      (cause: unknown) => current && onError(`Could not list files: ${errorText(cause)}`),
    )
    return () => {
      current = false
    }
  }, [connected, wantsFiles, filesFresh, filesKey, thread.id, onError])
  const threads = Object.values(byId)
    .filter((other) => other.projectId === thread.projectId && other.id !== thread.id && other.status !== "archived")
    .sort((a, b) => a.sortIndex - b.sortIndex)
  return { commands, files: files?.paths ?? [], threads }
}

export function Composer({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const text = useDrafts((state) => state.byThreadId[thread.id] ?? "")
  const sending = useDrafts((state) => state.sending[thread.id])
  const connected = useConnection((state) => state.status === "connected")
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(0)
  /** Set only right after a pick, to put the caret after the inserted command; any edit or move hands it back. */
  const [placedCaret, setPlacedCaret] = useState<{ start: number } | undefined>()
  const inputRef = useRef<TextInput>(null)
  const [error, setError] = useState<string | null>(null)
  const unstarted = useUnstarted(thread)
  const server = useThreadServer(thread.id)?.id
  const busy = isThreadBusy(thread.status)
  const wantsFiles = completionAt(text, Math.min(caret, text.length))?.trigger === "@"
  const completions = useCompletions(thread, busy, wantsFiles, setError)
  const hasDraft = text.trim() !== ""

  useEffect(() => {
    if (connected) useModels.getState().load(server, thread.provider).catch((cause: unknown) => setError(errorText(cause)))
  }, [connected, server, thread.provider])

  const send = async () => {
    // A second tap can land before the re-render that empties the composer, so check the store, not `hasDraft`.
    const sent = useDrafts.getState().take(thread.id)
    const prompt = sent.trim()
    if (prompt === "") return useDrafts.getState().restore(thread.id, sent)
    const workspace = unstarted ? useDrafts.getState().workspaces[thread.id] : undefined
    setError(null)
    try {
      await useDrafts.getState().trackSending(thread.id, prompt, () =>
        busy
          ? call("threads.steer", { threadId: thread.id, text: prompt })
          : call("threads.send", {
              threadId: thread.id,
              prompt,
              workspace: workspace && { mode: workspace.mode, target: toCheckoutTarget(workspace.ref) },
            }),
      )
    } catch (cause) {
      useDrafts.getState().restore(thread.id, sent)
      setError(errorText(cause))
    }
  }

  const stop = () => {
    setError(null)
    call("threads.interrupt", { threadId: thread.id }).catch((cause: unknown) => setError(errorText(cause)))
  }

  return (
    <View style={[styles.composer, { borderColor: theme.border, backgroundColor: theme.background }]}>
      {sending?.map((prompt) => (
        <View key={prompt.id} testID="composer-sending" style={styles.sending}>
          <Text style={[styles.sendingLabel, { color: theme.textMuted }]}>
            {copy(connected ? "mobile_composer_sending" : "mobile_composer_sends_when_back")}
          </Text>
          <Text numberOfLines={2} style={[styles.sendingText, { color: theme.text }]}>
            {prompt.text}
          </Text>
        </View>
      ))}
      <Suggestions
        text={text}
        caret={caret}
        completions={completions}
        onPick={(next, position) => {
          useDrafts.getState().setText(thread.id, next)
          setCaret(position)
          setPlacedCaret({ start: position })
          inputRef.current?.focus()
        }}
      />
      <View
        style={[styles.bar, { backgroundColor: theme.surface, borderColor: focused ? theme.primary : theme.border }]}
      >
        <TextInput
          ref={inputRef}
          testID="composer-input"
          accessibilityLabel="Message"
          value={text}
          selection={placedCaret && { start: placedCaret.start, end: placedCaret.start }}
          onChangeText={(next) => {
            setPlacedCaret(undefined)
            setCaret(caretAfterEdit(text, next))
            useDrafts.getState().setText(thread.id, next)
          }}
          onSelectionChange={(event) => {
            setCaret(event.nativeEvent.selection.end)
            if (event.nativeEvent.selection.end !== placedCaret?.start) setPlacedCaret(undefined)
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={busy ? "Steer the running turn" : "Ask the agent"}
          placeholderTextColor={theme.textMuted}
          multiline
          style={[styles.input, { color: theme.text }]}
        />
        <View style={styles.toolbar}>
          <View style={styles.chips}>
            <SettingsChip thread={thread} onError={setError} />
            {unstarted && <WorkspaceChip thread={thread} onError={setError} />}
          </View>
          <SendButton busy={busy} hasDraft={hasDraft} onSend={() => void send()} onStop={stop} />
        </View>
      </View>
      {error !== null && (
        <Text accessibilityRole="alert" style={[styles.error, { color: theme.danger }]}>
          {error}
        </Text>
      )}
    </View>
  )
}

/**
 * Completions for the `/command`, `$skill` or `@mention` token at the caret. Picking one replaces the token.
 */
function Suggestions({
  text,
  caret,
  completions,
  onPick,
}: {
  text: string
  caret: number
  completions: ReturnType<typeof useCompletions>
  onPick: (text: string, caret: number) => void
}) {
  const theme = useTheme()
  // The selection can arrive before the text it belongs to.
  const completion = completionAt(text, Math.min(caret, text.length))
  if (completion === null) return null
  const suggestions = suggestionsFor(completion, completions.commands, completions.files, completions.threads)
  if (suggestions.length === 0) return null

  const pick = (suggestion: Suggestion) => {
    const insert = `${suggestion.insert} `
    const rest = text.slice(completion.end).replace(/^ /, "")
    onPick(text.slice(0, completion.start) + insert + rest, completion.start + insert.length)
  }

  return (
    <ScrollView
      testID="composer-suggestions"
      accessibilityLabel={completion.trigger === "@" ? "Mentions" : "Commands"}
      keyboardShouldPersistTaps="always"
      style={[
        styles.suggestions,
        {
          maxHeight: SUGGESTION_HEIGHT * VISIBLE_SUGGESTIONS,
          backgroundColor: theme.surface,
          borderColor: theme.border,
        },
      ]}
    >
      {suggestions.map((suggestion) => (
        <Pressable
          key={suggestion.insert}
          accessibilityRole="button"
          accessibilityLabel={suggestion.type === "thread" ? suggestion.thread.title : suggestion.insert}
          accessibilityHint={suggestion.type === "command" ? suggestion.command.description || undefined : undefined}
          onPress={() => pick(suggestion)}
          style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: theme.surfaceStrong }]}
        >
          <SuggestionRow suggestion={suggestion} />
        </Pressable>
      ))}
    </ScrollView>
  )
}

function SuggestionRow({ suggestion }: { suggestion: Suggestion }) {
  const theme = useTheme()
  switch (suggestion.type) {
    case "command": {
      const { command } = suggestion
      return (
        <>
          <Text numberOfLines={1} style={[styles.suggestionName, { color: theme.text }]}>
            {suggestion.insert}
            {command.argumentHint !== "" && <Text style={{ color: theme.textMuted }}> {command.argumentHint}</Text>}
          </Text>
          {command.description !== "" && (
            <Text numberOfLines={1} style={[styles.suggestionDescription, { color: theme.textMuted }]}>
              {command.description}
            </Text>
          )}
        </>
      )
    }
    case "thread": {
      const { thread } = suggestion
      return (
        <View style={styles.suggestionLine}>
          <Icon name={providers[thread.provider].icon} size={14} color={theme.textMuted} />
          <Text numberOfLines={1} style={[styles.suggestionTitle, { color: theme.text }]}>
            {thread.title}
          </Text>
          <Text numberOfLines={1} style={[styles.suggestionDescription, { color: theme.textMuted }]}>
            {thread.model}
          </Text>
        </View>
      )
    }
    case "file":
      return (
        <View style={styles.suggestionLine}>
          <Icon name="RiFileLine" size={14} color={theme.textMuted} />
          <Text
            numberOfLines={1}
            ellipsizeMode="head"
            style={[styles.suggestionTitle, styles.suggestionName, { color: theme.text }]}
          >
            {suggestion.path}
          </Text>
        </View>
      )
  }
}

/** While the agent runs, an empty composer offers Stop and a draft offers Steer. */
function SendButton({
  busy,
  hasDraft,
  onSend,
  onStop,
}: {
  busy: boolean
  hasDraft: boolean
  onSend: () => void
  onStop: () => void
}) {
  const theme = useTheme()
  const stopping = busy && !hasDraft
  const action = stopping ? "stop" : busy ? "steer" : "send"
  const label = stopping ? "Stop" : busy ? "Steer" : "Send"
  const disabled = !stopping && !hasDraft
  const [background, foreground] = stopping
    ? [theme.dangerBg, theme.danger]
    : disabled
      ? [theme.surfaceStrong, theme.textMuted]
      : [theme.primary, theme.onPrimary]

  return (
    <Pressable
      testID={`composer-${action}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={stopping ? onStop : onSend}
      hitSlop={(HIT - SEND_SIZE) / 2}
      style={({ pressed }) => [styles.send, { backgroundColor: background }, pressed && styles.pressed]}
    >
      <Icon name={stopping ? "RiStopFill" : "RiArrowUpLine"} size={stopping ? 14 : 18} color={foreground} />
    </Pressable>
  )
}

/** The agent's listed models, plus the thread's own model when the agent no longer lists it. */
function useThreadModels(thread: Thread) {
  const server = useThreadServer(thread.id)?.id
  const listed = useModels((state) => modelsOn(state, server, thread.provider))
  const current = listed?.find((model) => model.id === thread.model)
  return current
    ? { models: listed ?? [], current }
    : { models: [unlistedModel(thread.model, thread.provider), ...(listed ?? [])], current: undefined }
}

const providers: Record<ProviderId, { label: string; icon: IconName }> = {
  claude: { label: "Claude Code", icon: "RiClaudeFill" },
  codex: { label: "Codex", icon: "RiOpenaiFill" },
  muse: { label: "Muse Code", icon: "RiMetaFill" },
}

const effortLabels: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
}
const effortLabel = (effort: string) => effortLabels[effort] ?? effort

const DEFAULT_EFFORT = "default"

const accessModes: Record<AccessMode, { label: string; icon: IconName }> = {
  supervised: { label: "Supervised", icon: "RiShieldUserLine" },
  auto: { label: "Auto", icon: "RiShieldCheckLine" },
  full: { label: "Full access", icon: "RiLockUnlockLine" },
}

/** What each mode lets through, which differs by agent and, for Claude's auto mode, by model. */
const supervisedHints: Record<ProviderId, string> = {
  claude: "Asks before edits and commands",
  codex: "Asks before any command that isn't read-only",
  muse: "Asks before commands and edits",
}

const autoHints: Record<ProviderId, (model: ModelInfo | undefined) => string> = {
  claude: (model) =>
    model?.autoMode ? "Claude approves safe actions and asks about the rest" : "Edits run without asking; commands still ask",
  codex: () => "Runs freely in the sandbox; asks to go beyond it",
  muse: () => "Runs freely in the sandbox, network included; asks to go beyond it",
}

const accessHint = (accessMode: AccessMode, thread: Thread, model: ModelInfo | undefined) => {
  switch (accessMode) {
    case "supervised":
      return supervisedHints[thread.provider]
    case "auto":
      return autoHints[thread.provider](model)
    case "full":
      return "Runs everything without asking"
  }
}

/**
 * The one chip the narrow toolbar has room for: the agent's mark and the model name. It opens a
 * full-height sheet with every setting the desktop composer spreads across its toolbar.
 */
function SettingsChip({ thread, onError }: { thread: Thread; onError: OnError }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const { models } = useThreadModels(thread)
  const modelLabel = models.find((model) => model.id === thread.model)?.label ?? thread.model
  return (
    <>
      <Pressable
        testID="composer-settings"
        accessibilityRole="button"
        accessibilityLabel="Thread settings"
        accessibilityValue={{ text: `${providers[thread.provider].label}, ${modelLabel}` }}
        onPress={() => setOpen(true)}
        hitSlop={{ top: (HIT - CHIP_HEIGHT) / 2, bottom: (HIT - CHIP_HEIGHT) / 2 }}
        style={({ pressed }) => [
          styles.chip,
          pressed && { backgroundColor: theme.surfaceStrong },
          pressed && styles.pressed,
        ]}
      >
        <Icon name={providers[thread.provider].icon} size={14} color={theme.textMuted} />
        <Text numberOfLines={1} style={[styles.chipLabel, { color: theme.text }]}>
          {modelLabel}
        </Text>
        <Icon name="RiArrowDownSLine" size={12} color={theme.textMuted} />
      </Pressable>
      <SettingsSheet thread={thread} open={open} onClose={() => setOpen(false)} onError={onError} />
    </>
  )
}

function SettingsSheet({
  thread,
  open,
  onClose,
  onError,
}: {
  thread: Thread
  open: boolean
  onClose: () => void
  onError: OnError
}) {
  const theme = useTheme()
  const { models, current } = useThreadModels(thread)
  const unstarted = useUnstarted(thread)

  // Effort and fast mode the next model cannot honor go back to its defaults.
  const changeModel = (id: string) => {
    const next = models.find((model) => model.id === id)
    if (next === undefined || next.id === thread.model) return
    void update(
      {
        id: thread.id,
        model: next.id,
        ...(thread.effort !== null && !next.efforts.includes(thread.effort) ? { effort: null } : {}),
        ...(thread.fastMode && !next.fastMode ? { fastMode: false } : {}),
      },
      onError,
    )
  }

  const defaultEffort = current?.defaultEffort ? `Default (${effortLabel(current.defaultEffort)})` : "Default effort"

  return (
    <Sheet title="Thread settings" open={open} onClose={onClose}>
          {unstarted && (
            <Section title="Agent">
              {ProviderId.literals.map((provider) => (
                <OptionRow
                  key={provider}
                  label={providers[provider].label}
                  icon={providers[provider].icon}
                  selected={provider === thread.provider}
                  onPress={() => provider !== thread.provider && void update({ id: thread.id, provider }, onError)}
                />
              ))}
            </Section>
          )}
          <Section title="Model">
            {models.map((model) => (
              <OptionRow
                key={model.id}
                label={model.label}
                selected={model.id === thread.model}
                onPress={() => changeModel(model.id)}
              />
            ))}
          </Section>
          {current !== undefined && current.efforts.length > 0 && (
            <Section title="Effort">
              {[
                { value: DEFAULT_EFFORT, label: defaultEffort },
                ...current.efforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
              ].map((option) => {
                const selected = (thread.effort ?? DEFAULT_EFFORT) === option.value
                return (
                  <OptionRow
                    key={option.value}
                    label={option.label}
                    selected={selected}
                    onPress={() =>
                      !selected &&
                      void update(
                        { id: thread.id, effort: option.value === DEFAULT_EFFORT ? null : option.value },
                        onError,
                      )
                    }
                  />
                )
              })}
            </Section>
          )}
          {current?.fastMode && (
            <Section title="Speed">
              <View style={sheetStyles.option}>
                <Icon name="RiFlashlightLine" size={18} color={theme.text} />
                <View style={sheetStyles.optionText}>
                  <Text style={[sheetStyles.optionLabel, { color: theme.text }]}>Fast mode</Text>
                  <Text style={[sheetStyles.optionHint, { color: theme.textMuted }]}>
                    Faster responses that use more of your plan
                  </Text>
                </View>
                <Toggle
                  accessibilityLabel="Fast mode"
                  value={thread.fastMode}
                  onValueChange={(fastMode) => void update({ id: thread.id, fastMode }, onError)}
                />
              </View>
            </Section>
          )}
          <Section title="Access">
            {AccessMode.literals.map((mode) => (
              <OptionRow
                key={mode}
                label={accessModes[mode].label}
                icon={accessModes[mode].icon}
                hint={accessHint(mode, thread, current)}
                color={mode === "full" ? theme.danger : undefined}
                selected={mode === thread.accessMode}
                onPress={() => mode !== thread.accessMode && void update({ id: thread.id, accessMode: mode }, onError)}
              />
            ))}
          </Section>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 12, gap: 6 },
  bar: { borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 6 },
  input: {
    minHeight: LINE_HEIGHT + INPUT_PADDING * 2,
    maxHeight: LINE_HEIGHT * MAX_LINES + INPUT_PADDING * 2,
    paddingHorizontal: 6,
    paddingVertical: INPUT_PADDING,
    fontSize: 15,
    lineHeight: LINE_HEIGHT,
    textAlignVertical: "top",
    // react-native-web renders a fixed-height textarea; this lets the browser grow it with its text.
    ...Platform.select({ web: { fieldSizing: "content", outlineStyle: "none" } as object }),
  },
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  chips: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 2 },
  suggestions: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  suggestion: { minHeight: SUGGESTION_HEIGHT, justifyContent: "center", gap: 2, paddingHorizontal: 12, paddingVertical: 6 },
  suggestionName: { fontFamily: mono, fontSize: 14 },
  suggestionDescription: { fontSize: 13 },
  suggestionLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  suggestionTitle: { flexShrink: 1, fontSize: 15 },
  chip: {
    height: CHIP_HEIGHT,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 8,
    paddingRight: 10,
    borderRadius: radius.full,
  },
  chipLabel: { flexShrink: 1, fontSize: 13, fontWeight: "500" },
  pressed: { transform: [{ scale: 0.96 }] },
  send: {
    width: SEND_SIZE,
    height: SEND_SIZE,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  error: { fontSize: 13, paddingHorizontal: 4 },
  sending: { gap: 2, paddingHorizontal: 4 },
  sendingLabel: { fontSize: 12, fontWeight: "500" },
  sendingText: { fontSize: 15, lineHeight: LINE_HEIGHT },
})
