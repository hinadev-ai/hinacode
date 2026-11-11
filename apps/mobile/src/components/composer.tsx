import { useAtomMount, useAtomSubscribe, useAtomValue } from "@effect/atom-react"
import {
  type AccountLimits,
  type AgentCommand,
  type AgentProfile,
  presetModels,
  ProviderId,
  unlistedModel,
} from "@shared/agent.ts"
import { completionAt, type Suggestion, suggestionsFor } from "@shared/composerSyntax.ts"
import { isThreadBusy, type Settings, type Thread, toCheckoutTarget } from "@shared/domain.ts"
import { type AccountOption, accountOptions, formatResetIn } from "@shared/planLimits.ts"
import { providerInfo } from "@shared/providers.ts"
import { mentionableThreads } from "@shared/mentions.ts"
import { Effect, Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useEffect, useRef, useState } from "react"
import {
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { AccessModeSection, accessModes } from "@/components/access-mode"
import { ComposerInput } from "@/components/composer-input"
import type { ComposerInputHandle } from "@/components/composer-input.types"
import { GlassFill, liquidGlass } from "@/components/glass"
import { LocationChip } from "@/components/draft-location"
import { Icon, type IconName } from "@/components/icon"
import { Spinner } from "@/components/motion"
import { OptionRow, Section, Sheet, sheetStyles } from "@/components/sheet"
import { ProviderMark, Toggle } from "@/components/ui"
import { WorkspaceChip } from "@/components/workspace-picker"
import { cssEase, ease, PRESSED_SCALE, pressSpring } from "@/constants/motion"
import { HIT, mono, ProviderColors, radius } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useThreadServer } from "@/hooks/use-server"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { call, request, type RpcError, useConnection } from "@/lib/connection"
import { artifactSkillCommands } from "@/lib/artifact-skills"
import { keepSkillWhole } from "@/lib/composer-text"
import { copy, locale } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { motion } from "@/lib/motion"
import { familyOf, beforeFirstHandshake, reportFailure } from "@/lib/remote"
import { pickImages, stageImage } from "@/lib/stage-images"
import { type DraftImage, useDrafts } from "@/stores/drafts"
import { useMessages } from "@/stores/messages"
import { modelsLoadAtom, modelsOn, useModels } from "@/stores/models"
import { updateThread, useThreads } from "@/stores/threads"

type OnError = (message: string) => void

const LINE_HEIGHT = 20
const INPUT_PADDING = 6
const MAX_LINES = 5
const CHIP_HEIGHT = 36
const SEND_SIZE = 40
const COMPOSER_RADIUS = 28
const IMAGE_SIZE = 56
const SUGGESTION_HEIGHT = 48
const VISIBLE_SUGGESTIONS = 4.5

// FIXME: react-native-web fires no selection event while typing, so the caret is derived from the edit.
const caretAfterEdit = (before: string, after: string) => {
  let prefix = 0
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  const maxSuffix = Math.min(before.length, after.length) - prefix
  while (suffix < maxSuffix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  return after.length - suffix
}

function useUnstarted(thread: Thread) {
  return useMessages((state) => {
    const history = state.byThread[thread.id]
    return history?.status === "ready" && history.messages.length === 0 && thread.worktreeId === null
  })
}

interface CompletionSource {
  readonly threadId: string
  readonly provider: ProviderId
  readonly accountId: string | null
  readonly worktreeId: string | null
  readonly busy: boolean
}

type FilesSource = Pick<CompletionSource, "threadId" | "worktreeId" | "busy">

const commandsAtom = familyOf((source: CompletionSource) =>
  Atom.make((get) => {
    if (beforeFirstHandshake(get)) return Effect.never
    return request("commands.list", { threadId: source.threadId })
  }),
)

const filesAtom = familyOf((source: FilesSource) =>
  Atom.make(request("files.list", { threadId: source.threadId })).pipe(Atom.setIdleTTL("10 minutes")),
)

const noFilesAtom: Atom.Atom<AsyncResult.AsyncResult<readonly string[], RpcError>> = Atom.make(AsyncResult.initial())

function useCompletions(thread: Thread, busy: boolean, wantsFiles: boolean, onError: OnError) {
  const byId = useThreads((state) => state.byId)
  const projects = useThreads((state) => state.projects)
  const commands = commandsAtom({
    threadId: thread.id,
    provider: thread.provider,
    accountId: thread.accountId,
    worktreeId: thread.worktreeId,
    busy,
  })
  const listedCommands = AsyncResult.getOrElse(useAtomValue(commands), (): readonly AgentCommand[] => [])
  useAtomSubscribe(commands, reportFailure((message) => onError(copy("mobile_composer_commands_failed", { message }))))

  const files = wantsFiles ? filesAtom({ threadId: thread.id, worktreeId: thread.worktreeId, busy }) : noFilesAtom
  const listedFiles = Option.getOrElse(AsyncResult.value(useAtomValue(files)), (): readonly string[] => [])
  useAtomSubscribe(files, reportFailure((message) => onError(copy("mobile_composer_files_failed", { message }))))

  const threads = mentionableThreads(thread, Object.values(byId), projects)
  return { commands: [...artifactSkillCommands, ...listedCommands], files: listedFiles, threads }
}

export function Composer({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const text = useDrafts((state) => state.byThreadId[thread.id] ?? "")
  const sending = useDrafts((state) => state.sending[thread.id])
  const images = useDrafts((state) => state.images[thread.id]) ?? []
  const [staging, setStaging] = useState(false)
  const connected = useConnection((state) => state.status === "connected")
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(0)
  const [placedCaret, setPlacedCaret] = useState<{ start: number } | undefined>()
  const inputRef = useRef<ComposerInputHandle>(null)
  const [error, setError] = useState<string | null>(null)
  const unstarted = useUnstarted(thread)
  const server = useThreadServer(thread.id)?.id
  const busy = isThreadBusy(thread.status)
  const steers = providerInfo[thread.provider].steersRunningTurn
  const wantsFiles = completionAt(text, Math.min(caret, text.length))?.trigger === "@"
  const completions = useCompletions(thread, busy, wantsFiles, setError)
  const { commands, files, threads } = completions
  const known = {
    commands: new Set(commands.map((command) => command.trigger + command.name)),
    files: new Set(files),
    threads: new Set([...threads.sameMachine, ...threads.otherMachines].map((other) => other.id)),
    terminals: new Set<string>(),
    artifacts: new Set<string>(),
  }
  const hasDraft = text.trim() !== "" || images.length > 0

  useAtomMount(modelsLoadAtom(server, thread.provider))
  useAtomSubscribe(modelsLoadAtom(server, thread.provider), reportFailure(setError))

  useEffect(() => {
    if (Platform.OS !== "android") return
    const hidden = Keyboard.addListener("keyboardDidHide", () => inputRef.current?.blur())
    return () => hidden.remove()
  }, [])

  const stop = async () => {
    setError(null)
    try {
      await call("threads.interrupt", { threadId: thread.id })
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const send = async () => {
    // oxlint-disable-next-line hinacode/no-comments
    // A second tap can land before the re-render that empties the composer, so check the store, not `hasDraft`.
    const sent = useDrafts.getState().take(thread.id)
    const prompt = sent.text.trim()
    if (prompt === "" && sent.images.length === 0) return useDrafts.getState().restore(thread.id, sent)
    const attachments = sent.images.map((image) => image.attachment)
    const workspace = unstarted ? useDrafts.getState().workspaces[thread.id] : undefined
    const sendingLabel = prompt || attachments.map(({ name }) => name).join(", ")
    setError(null)
    try {
      await useDrafts.getState().trackSending(thread.id, sendingLabel, () =>
        busy
          ? call(steers ? "threads.steer" : "threads.queue", { threadId: thread.id, text: prompt, attachments })
          : call("threads.send", {
              threadId: thread.id,
              prompt,
              attachments,
              workspace: workspace && { mode: workspace.mode, target: toCheckoutTarget(workspace.ref) },
            }),
      )
    } catch (cause) {
      useDrafts.getState().restore(thread.id, sent)
      setError(errorText(cause))
    }
  }

  const stageImages = async (assets: readonly Parameters<typeof stageImage>[1][]) => {
    if (assets.length === 0) return
    setError(null)
    setStaging(true)
    const results = await Promise.allSettled(assets.map((asset) => stageImage(thread.id, asset)))
    setStaging(false)
    const staged = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
    useDrafts.getState().addImages(thread.id, staged)
    const failed = results.find((result) => result.status === "rejected")
    if (failed) setError(errorText(failed.reason))
  }

  const attachImages = async () => stageImages(await pickImages())

  return (
    <View style={styles.composer}>
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
        style={[
          styles.bar,
          {
            backgroundColor: liquidGlass ? "transparent" : theme.background,
            borderColor: focused ? theme.primary : theme.border,
          },
          styles.raised,
          focused && { boxShadow: `0 0 0 2px ${theme.primary}` },
        ]}
      >
        <GlassFill style={styles.barGlass} />
        {images.length > 0 && (
          <DraftImages images={images} onRemove={(id) => useDrafts.getState().removeImage(thread.id, id)} />
        )}
        <ComposerInput
          ref={inputRef}
          testID="composer-input"
          accessibilityLabel={copy("mobile_composer_message")}
          value={text}
          commands={commands}
          known={known}
          selection={placedCaret && { start: placedCaret.start, end: placedCaret.start }}
          onChangeText={(typed) => {
            const next = keepSkillWhole(text, typed, commands)
            const position = caretAfterEdit(text, next)
            // FIXME: The native input leaves the caret where a whole-skill deletion happened, so it is put back explicitly.
            setPlacedCaret(next === typed ? undefined : { start: position })
            setCaret(position)
            useDrafts.getState().setText(thread.id, next)
          }}
          onChangeSelection={(selection) => {
            setCaret(selection.end)
            if (selection.end !== placedCaret?.start) setPlacedCaret(undefined)
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPasteImages={(pasted) => void stageImages(pasted)}
          placeholder={
            busy
              ? copy(steers ? "mobile_composer_steer_placeholder" : "mobile_composer_queue_placeholder")
              : copy("mobile_composer_placeholder")
          }
          style={styles.input}
        />
        {unstarted && (
          <View testID="composer-start-options" style={styles.chips}>
            <LocationChip thread={thread} onError={setError} />
            <WorkspaceChip thread={thread} onError={setError} />
          </View>
        )}
        <View style={styles.toolbar}>
          <View style={styles.chips}>
            <AttachButton staging={staging} onPress={() => void attachImages()} />
            <SettingsChip thread={thread} onError={setError} />
          </View>
          <View style={styles.chips}>
            <SendButton
              busy={busy}
              steers={steers}
              hasDraft={hasDraft && !staging}
              onSend={() => void send()}
              onStop={() => void stop()}
            />
          </View>
        </View>
      </View>
      {error !== null && (
        <Text accessibilityRole="alert" numberOfLines={3} style={[styles.error, { color: theme.danger }]}>
          {error}
        </Text>
      )}
    </View>
  )
}

function AttachButton({ staging, onPress }: { staging: boolean; onPress: () => void }) {
  const theme = useTheme()
  return (
    <Pressable
      testID="composer-attach"
      accessibilityRole="button"
      accessibilityLabel={copy("mobile_composer_attach_images")}
      accessibilityState={{ busy: staging, disabled: staging }}
      disabled={staging}
      onPress={onPress}
      hitSlop={(HIT - CHIP_HEIGHT) / 2}
      style={({ pressed }) => [
        styles.attach,
        pressed && [styles.pressed, { backgroundColor: theme.inkWash }],
      ]}
    >
      {staging ? <Spinner size={18} color={theme.textMuted} /> : <Icon name="Plus" size={20} color={theme.textMuted} />}
    </Pressable>
  )
}

function DraftImages({ images, onRemove }: { images: readonly DraftImage[]; onRemove: (id: string) => void }) {
  const theme = useTheme()
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.images}>
      {images.map(({ attachment, preview }) => (
        <View key={attachment.id} testID="composer-image">
          <Image
            source={{ uri: preview }}
            accessibilityLabel={attachment.name}
            style={[styles.image, { backgroundColor: theme.surfaceStrong }]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy("mobile_composer_remove_image", { name: attachment.name })}
            onPress={() => onRemove(attachment.id)}
            hitSlop={8}
            style={styles.removeImage}
          >
            <Icon name="XCircleFill" size={20} color={theme.text} />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  )
}

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
  // FIXME: React Native can deliver the selection before the text it belongs to.
  const completion = completionAt(text, Math.min(caret, text.length))
  if (completion === null) return null
  const suggestions = suggestionsFor(completion, completions.commands, completions.files, completions.threads, [], [], [])
  if (suggestions.length === 0) return null

  const pick = (suggestion: Suggestion) => {
    const insert = `${suggestion.insert} `
    const rest = text.slice(completion.end).replace(/^ /, "")
    onPick(text.slice(0, completion.start) + insert + rest, completion.start + insert.length)
  }

  return (
    <ScrollView
      testID="composer-suggestions"
      accessibilityLabel={completion.trigger === "@" ? copy("mobile_composer_mentions") : copy("mobile_composer_commands")}
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
          <ProviderMark provider={thread.provider} size={14} />
          <Text numberOfLines={1} style={[styles.suggestionTitle, { color: theme.text }]}>
            {thread.title}
          </Text>
          <Text numberOfLines={1} style={[styles.suggestionDescription, { color: theme.textMuted }]}>
            {thread.model}
          </Text>
        </View>
      )
    }
    case "file": {
      const slash = suggestion.path.lastIndexOf("/")
      return (
        <View style={styles.suggestionLine}>
          <Icon name="File" size={14} color={theme.textMuted} />
          <Text numberOfLines={1} style={[styles.suggestionFile, { color: theme.text }]}>
            {suggestion.path.slice(slash + 1)}
          </Text>
          <Text numberOfLines={1} style={[styles.suggestionFolder, { color: theme.textMuted }]}>
            {suggestion.path.slice(0, slash + 1)}
          </Text>
        </View>
      )
    }
  }
}

function SendButton({
  busy,
  steers,
  hasDraft,
  onSend,
  onStop,
}: {
  busy: boolean
  steers: boolean
  hasDraft: boolean
  onSend: () => void
  onStop: () => void
}) {
  const theme = useTheme()
  const action = !busy ? "send" : hasDraft ? (steers ? "steer" : "queue") : "stop"
  const label = copy(`mobile_composer_${action}`)
  const disabled = action !== "stop" && !hasDraft
  const background = disabled ? theme.inkWash : theme.primary

  return (
    <motion.Pressable
      testID={`composer-${action}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={action === "stop" ? onStop : onSend}
      hitSlop={(HIT - SEND_SIZE) / 2}
      animate={{ backgroundColor: background }}
      whileTap={{ scale: PRESSED_SCALE }}
      transition={{ ...pressSpring, backgroundColor: { ease: ease.swap } }}
      style={[styles.send, { borderColor: disabled ? theme.border : "transparent" }]}
    >
      {!disabled && <SendHalo />}
      <Icon
        name={action === "stop" ? "Stop" : "ArrowUp"}
        size={action === "stop" ? 16 : 20}
        color={disabled ? theme.textMuted : theme.haloInk}
      />
    </motion.Pressable>
  )
}

const spin = { from: { transform: [{ rotate: "0deg" }] }, to: { transform: [{ rotate: "360deg" }] } }

function SendHalo() {
  const theme = useTheme()
  const reduced = useReducedMotion()
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View
        style={[
          styles.haloSweep,
          {
            experimental_backgroundImage: `linear-gradient(135deg, ${theme.haloA}, ${theme.haloB} 35%, ${theme.haloC} 65%, ${theme.haloD})`,
          },
          !reduced && {
            animationName: spin,
            animationDuration: 1200,
            animationIterationCount: 1,
            animationTimingFunction: cssEase.out,
          },
        ]}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          { experimental_backgroundImage: `radial-gradient(circle, ${theme.haloCore}b3 0%, transparent 70%)` },
        ]}
      />
      <Image source={require("../../assets/images/send-grain.png")} style={styles.haloGrain} />
    </View>
  )
}

export function useThreadModels(thread: Thread) {
  const server = useThreadServer(thread.id)?.id
  const listed = useModels((state) => modelsOn(state, server, thread.provider))
  const current = listed?.find((model) => model.id === thread.model)
  return current
    ? { models: listed ?? [], current }
    : { models: [unlistedModel(thread.model, thread.provider), ...(listed ?? [])], current: undefined }
}

const providers: Record<ProviderId, { label: string; icon: IconName }> = {
  claude: { label: copy("mobile_provider_claude"), icon: "RiClaudeFill" },
  codex: { label: copy("mobile_provider_codex"), icon: "RiOpenaiFill" },
  muse: { label: copy("mobile_provider_muse"), icon: "RiMetaFill" },
  opencode: { label: copy("mobile_provider_opencode"), icon: "OpencodeMark" },
  magpie: { label: copy("mobile_provider_magpie"), icon: "MagpieMark" },
}

const effortLabels: Record<string, string> = {
  none: copy("mobile_composer_effort_none"),
  minimal: copy("mobile_composer_effort_minimal"),
  low: copy("mobile_composer_effort_low"),
  medium: copy("mobile_composer_effort_medium"),
  high: copy("mobile_composer_effort_high"),
  xhigh: copy("mobile_composer_effort_xhigh"),
  max: copy("mobile_composer_effort_max"),
  ultra: copy("mobile_composer_effort_ultra"),
}
const effortLabel = (effort: string) => effortLabels[effort] ?? effort

const DEFAULT_EFFORT = "default"

const serverOptionsAtom = familyOf((server: string | null) =>
  Atom.make((get) => {
    if (beforeFirstHandshake(get)) return Effect.never
    const on = server === null ? undefined : { server }
    return Effect.all(
      {
        profiles: request("accounts.list", undefined, on),
        limits: request("limits.list", undefined, on).pipe(Effect.orElseSucceed((): readonly AccountLimits[] => [])),
        settings: request("settings.get", undefined, on),
      },
      { concurrency: "unbounded" },
    )
  }),
)

interface ServerOptions {
  readonly profiles: readonly AgentProfile[]
  readonly limits: readonly AccountLimits[]
  readonly settings: Pick<Settings, "defaultAccountName" | "modelPresets">
}

const closedOptionsAtom: Atom.Atom<AsyncResult.AsyncResult<ServerOptions, RpcError>> = Atom.make(AsyncResult.initial())

function useServerOptions(server: string | undefined, open: boolean, onError: OnError) {
  const options = open ? serverOptionsAtom(server ?? null) : closedOptionsAtom
  useAtomSubscribe(options, reportFailure(onError))
  return AsyncResult.getOrElse(useAtomValue(options), () => null)
}

const accountHint = (option: AccountOption, now: number) =>
  option.spent !== undefined
    ? option.spent.resetsAt === null
      ? copy("mobile_thread_account_limit_reached_no_reset")
      : copy("mobile_thread_account_limit_reached", { duration: formatResetIn(option.spent.resetsAt, now, locale) })
    : option.mostUsed !== undefined
      ? copy("mobile_thread_account_used", { percent: String(Math.round(option.mostUsed.usedPercent)) })
      : undefined

const switchAccount = async (thread: Thread, accountId: string | null, onError: OnError) => {
  try {
    useThreads.getState().upsert(await call("threads.switchAccount", { id: thread.id, accountId }))
  } catch (cause) {
    onError(errorText(cause))
  }
}

export function useSettingsSummary(thread: Thread) {
  const { models, current } = useThreadModels(thread)
  const modelLabel = models.find((model) => model.id === thread.model)?.label ?? thread.model
  const effort = current?.efforts.length ? (thread.effort ?? current.defaultEffort) : null
  return { providerLabel: providers[thread.provider].label, modelLabel, effortText: effort ? effortLabel(effort) : null }
}

function SettingsChip({ thread, onError }: { thread: Thread; onError: OnError }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const { providerLabel, modelLabel, effortText } = useSettingsSummary(thread)
  return (
    <>
      <Pressable
        testID="composer-settings"
        accessibilityRole="button"
        accessibilityLabel={copy("mobile_composer_settings")}
        accessibilityValue={{
          text: [providerLabel, modelLabel, effortText].filter(Boolean).join(", "),
        }}
        onPress={() => setOpen(true)}
        hitSlop={{ top: (HIT - CHIP_HEIGHT) / 2, bottom: (HIT - CHIP_HEIGHT) / 2 }}
        style={({ pressed }) => [
          styles.chip,
          pressed && [styles.pressed, { backgroundColor: theme.inkWash }],
        ]}
      >
        <ProviderMark provider={thread.provider} size={14} />
        <Text numberOfLines={1} style={[styles.chipLabel, { color: theme.text }]}>
          {modelLabel}
          {effortText !== null && <Text style={{ color: theme.textMuted }}>{` · ${effortText}`}</Text>}
        </Text>
        {thread.accessMode === "full" && <Icon name={accessModes.full.icon} size={14} color={theme.danger} />}
        <Icon name="ChevronDown" size={12} color={theme.textMuted} />
      </Pressable>
      <SettingsSheet thread={thread} open={open} onClose={() => setOpen(false)} onError={onError} />
    </>
  )
}

export function SettingsSheet({
  thread,
  open,
  onClose,
  onError,
  isNew = false,
}: {
  thread: Thread
  open: boolean
  onClose: () => void
  onError: OnError
  isNew?: boolean
}) {
  const now = useNow()
  const scheme = useScheme()
  const { models, current } = useThreadModels(thread)
  const unstarted = useUnstarted(thread) || isNew
  const options = useServerOptions(useThreadServer(thread.id)?.id, open, onError)
  const shownModels = presetModels(models, options?.settings.modelPresets[thread.provider] ?? [], thread.model)
  const accounts =
    options === null
      ? []
      : accountOptions(
          thread,
          options.settings.defaultAccountName[thread.provider] ?? copy("mobile_thread_account_default"),
          options.profiles,
          options.limits,
        )

  const changeModel = (id: string) => {
    const next = models.find((model) => model.id === id)
    if (next === undefined || next.id === thread.model) return
    void updateThread(
      {
        id: thread.id,
        model: next.id,
        ...(thread.effort !== null && !next.efforts.includes(thread.effort) ? { effort: null } : {}),
        ...(thread.fastMode && !next.fastMode ? { fastMode: false } : {}),
      },
      onError,
    )
  }

  const defaultEffort = current?.defaultEffort
    ? copy("mobile_composer_effort_default_named", { effort: effortLabel(current.defaultEffort) })
    : copy("mobile_composer_effort_default")

  return (
    <Sheet title={copy("mobile_composer_settings")} open={open} onClose={onClose} fit>
          {unstarted && (
            <Section title={copy("mobile_composer_agent")}>
              {ProviderId.literals.map((provider) => (
                <OptionRow
                  key={provider}
                  label={providers[provider].label}
                  icon={providers[provider].icon}
                  iconColor={ProviderColors[scheme][provider]}
                  selected={provider === thread.provider}
                  onPress={() => provider !== thread.provider && void updateThread({ id: thread.id, provider }, onError)}
                />
              ))}
            </Section>
          )}
          <Section title={copy("mobile_composer_model")}>
            {shownModels.map((model) => (
              <OptionRow
                key={model.id}
                label={model.label}
                selected={model.id === thread.model}
                onPress={() => changeModel(model.id)}
              />
            ))}
          </Section>
          {accounts.length > 1 && (
            <Section title={copy("mobile_thread_account")}>
              {accounts.map((account) => (
                <OptionRow
                  key={account.id ?? "cli"}
                  label={account.name}
                  hint={accountHint(account, now)}
                  selected={account.id === thread.accountId}
                  disabled={isThreadBusy(thread.status)}
                  onPress={() => account.id !== thread.accountId && void switchAccount(thread, account.id, onError)}
                />
              ))}
            </Section>
          )}
          {current !== undefined && current.efforts.length > 0 && (
            <Section title={copy("mobile_composer_effort")}>
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
                      void updateThread(
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
            <Section title={copy("mobile_composer_speed")} role="group">
              <ToggleRow
                icon="Bolt"
                label={copy("mobile_composer_fast_mode")}
                hint={copy("mobile_composer_fast_mode_hint")}
                value={thread.fastMode}
                onValueChange={(fastMode) => void updateThread({ id: thread.id, fastMode }, onError)}
              />
            </Section>
          )}
          <AccessModeSection thread={thread} model={current} onError={onError} />
    </Sheet>
  )
}

function ToggleRow({
  icon,
  label,
  hint,
  value,
  onValueChange,
}: {
  icon: IconName
  label: string
  hint: string
  value: boolean
  onValueChange: (value: boolean) => void
}) {
  const theme = useTheme()
  return (
    <View style={sheetStyles.option}>
      <Icon name={icon} size={18} color={theme.text} />
      <View style={sheetStyles.optionText}>
        <Text style={[sheetStyles.optionLabel, { color: theme.text }]}>{label}</Text>
        <Text style={[sheetStyles.optionHint, { color: theme.textMuted }]}>{hint}</Text>
      </View>
      <Toggle accessibilityLabel={label} value={value} onValueChange={onValueChange} />
    </View>
  )
}

const styles = StyleSheet.create({
  composer: { paddingHorizontal: 12, paddingBottom: 12, paddingTop: 4, gap: 6 },
  bar: { borderRadius: COMPOSER_RADIUS, borderWidth: StyleSheet.hairlineWidth, padding: 10, paddingTop: 12, gap: 10 },
  raised: { boxShadow: "0 4px 16px rgba(0, 0, 0, 0.06)" },
  barGlass: { borderRadius: COMPOSER_RADIUS, overflow: "hidden" },
  input: {
    minHeight: LINE_HEIGHT + INPUT_PADDING * 2,
    maxHeight: LINE_HEIGHT * MAX_LINES + INPUT_PADDING * 2,
    paddingHorizontal: 8,
    paddingVertical: INPUT_PADDING,
    fontSize: 17,
    lineHeight: LINE_HEIGHT,
    textAlignVertical: "top",
    // FIXME: react-native-web renders a fixed-height textarea; field-sizing lets the browser grow it with its text.
    ...Platform.select({ web: { fieldSizing: "content", outlineStyle: "none" } as object }),
  },
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  chips: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  suggestions: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  suggestion: { minHeight: SUGGESTION_HEIGHT, justifyContent: "center", gap: 2, paddingHorizontal: 12, paddingVertical: 6 },
  suggestionName: { fontFamily: mono, fontSize: 14 },
  suggestionDescription: { fontSize: 13 },
  suggestionLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  suggestionTitle: { flexShrink: 1, fontSize: 15 },
  suggestionFile: { flexShrink: 0, maxWidth: "70%", fontFamily: mono, fontSize: 14 },
  suggestionFolder: { flex: 1, fontSize: 13 },
  chip: {
    height: CHIP_HEIGHT,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 12,
    paddingRight: 12,
    borderRadius: radius.full,
  },
  attach: {
    width: CHIP_HEIGHT,
    height: CHIP_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.full,
  },
  images: { gap: 8, paddingHorizontal: 6, paddingTop: 6 },
  image: { width: IMAGE_SIZE, height: IMAGE_SIZE, borderRadius: radius.md },
  removeImage: { position: "absolute", top: -6, right: -6 },
  chipLabel: { flexShrink: 1, fontFamily: mono, fontSize: 13 },
  pressed: { transform: [{ scale: 0.96 }] },
  send: {
    width: SEND_SIZE,
    height: SEND_SIZE,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  haloSweep: {
    position: "absolute",
    width: SEND_SIZE * Math.SQRT2,
    height: SEND_SIZE * Math.SQRT2,
    left: (SEND_SIZE - SEND_SIZE * Math.SQRT2) / 2,
    top: (SEND_SIZE - SEND_SIZE * Math.SQRT2) / 2,
  },
  haloGrain: { ...StyleSheet.absoluteFill, width: SEND_SIZE, height: SEND_SIZE, mixBlendMode: "overlay", opacity: 0.55 },
  error: { fontSize: 13, paddingHorizontal: 4 },
  sending: { gap: 2, paddingHorizontal: 4 },
  sendingLabel: { fontSize: 12, fontWeight: "500" },
  sendingText: { fontSize: 15, lineHeight: LINE_HEIGHT },
})
