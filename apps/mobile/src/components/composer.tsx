import { type ModelInfo, ProviderId, unlistedModel } from "@shared/agent.ts"
import type { RpcRequest } from "@shared/contract.ts"
import { AccessMode, isThreadBusy, type Thread } from "@shared/domain.ts"
import { type ReactNode, useEffect, useState } from "react"
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon, type IconName } from "@/components/icon"
import { Colors, HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { useDrafts } from "@/stores/drafts"
import { useMessages } from "@/stores/messages"
import { useModels } from "@/stores/models"
import { useThreads } from "@/stores/threads"

export const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

type OnError = (message: string) => void

interface ControlProps {
  readonly thread: Thread
  readonly onError: OnError
}

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
const SHEET_PADDING = 8

export function Composer({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const text = useDrafts((state) => state.byThreadId[thread.id] ?? "")
  // Agent stays open to change until the first message, as on the desktop.
  const unstarted = useMessages((state) => {
    const history = state.byThread[thread.id]
    return history?.status === "ready" && history.messages.length === 0 && thread.worktreeId === null
  })
  const connected = useConnection((state) => state.status === "connected")
  const [focused, setFocused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = isThreadBusy(thread.status)
  const hasDraft = text.trim() !== ""

  useEffect(() => {
    if (connected) useModels.getState().load(thread.provider).catch((cause: unknown) => setError(errorText(cause)))
  }, [connected, thread.provider])

  const send = async () => {
    if (!hasDraft) return
    const sent = useDrafts.getState().take(thread.id)
    const prompt = sent.trim()
    setError(null)
    try {
      await (busy
        ? call("threads.steer", { threadId: thread.id, text: prompt })
        : call("threads.send", { threadId: thread.id, prompt }))
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
      <View
        style={[styles.bar, { backgroundColor: theme.surface, borderColor: focused ? theme.primary : theme.border }]}
      >
        <TextInput
          testID="composer-input"
          accessibilityLabel="Message"
          value={text}
          onChangeText={(next) => useDrafts.getState().setText(thread.id, next)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={busy ? "Steer the running turn" : "Ask the agent"}
          placeholderTextColor={theme.textMuted}
          multiline
          style={[styles.input, { color: theme.text }]}
        />
        <View style={styles.toolbar}>
          <View style={styles.controls}>
            {unstarted && <AgentPicker thread={thread} onError={setError} />}
            <ModelPicker thread={thread} onError={setError} />
            <EffortPicker thread={thread} onError={setError} />
            <FastModeToggle thread={thread} onError={setError} />
            <AccessPicker thread={thread} onError={setError} />
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
  const listed = useModels((state) => state.byProvider[thread.provider])
  const current = listed?.find((model) => model.id === thread.model)
  return current
    ? { models: listed ?? [], current }
    : { models: [unlistedModel(thread.model, thread.provider), ...(listed ?? [])], current: undefined }
}

const providers: Record<ProviderId, { label: string; icon: IconName }> = {
  claude: { label: "Claude Code", icon: "RiClaudeFill" },
  codex: { label: "Codex", icon: "RiOpenaiFill" },
}

function AgentPicker({ thread, onError }: ControlProps) {
  return (
    <Picker
      label="Agent"
      icon={providers[thread.provider].icon}
      value={thread.provider}
      options={ProviderId.literals.map((id) => ({ value: id, ...providers[id] }))}
      onChange={(provider) => void update({ id: thread.id, provider }, onError)}
    />
  )
}

function ModelPicker({ thread, onError }: ControlProps) {
  const { models } = useThreadModels(thread)

  // Effort and fast mode the next model cannot honor go back to its defaults.
  const change = (id: string) => {
    const next = models.find((model) => model.id === id)
    if (next === undefined) return
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

  return (
    <Picker
      label="Model"
      value={thread.model}
      options={models.map((model) => ({ value: model.id, label: model.label }))}
      onChange={change}
      shrink
    />
  )
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

/** Shown only for models with effort control. */
function EffortPicker({ thread, onError }: ControlProps) {
  const { current } = useThreadModels(thread)
  if (current === undefined || current.efforts.length === 0) return null
  const defaultLabel = current.defaultEffort ? `Default (${effortLabel(current.defaultEffort)})` : "Default effort"
  return (
    <Picker
      label="Effort"
      icon="RiBrainLine"
      value={thread.effort ?? DEFAULT_EFFORT}
      options={[
        { value: DEFAULT_EFFORT, label: defaultLabel },
        ...current.efforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
      ]}
      onChange={(value) => void update({ id: thread.id, effort: value === DEFAULT_EFFORT ? null : value }, onError)}
    />
  )
}

/** Shown only for models with a fast service tier. */
function FastModeToggle({ thread, onError }: ControlProps) {
  const { current } = useThreadModels(thread)
  if (!current?.fastMode) return null
  return (
    <Chip
      label="Fast"
      text="Fast"
      icon="RiFlashlightLine"
      hint="Faster responses that use more of your plan"
      selected={thread.fastMode}
      onPress={() => void update({ id: thread.id, fastMode: !thread.fastMode }, onError)}
    />
  )
}

const accessModes: Record<AccessMode, { label: string; icon: IconName }> = {
  supervised: { label: "Supervised", icon: "RiShieldUserLine" },
  auto: { label: "Auto", icon: "RiShieldCheckLine" },
  full: { label: "Full access", icon: "RiLockUnlockLine" },
}

/** What each mode lets through, which differs by agent and, for Claude's auto mode, by model. */
const accessHint = (accessMode: AccessMode, thread: Thread, model: ModelInfo | undefined) => {
  switch (accessMode) {
    case "supervised":
      return thread.provider === "codex"
        ? "Asks before any command that isn't read-only"
        : "Asks before edits and commands"
    case "auto":
      if (thread.provider === "codex") return "Runs freely in the sandbox; asks to go beyond it"
      return model?.autoMode
        ? "Claude approves safe actions and asks about the rest"
        : "Edits run without asking; commands still ask"
    case "full":
      return "Runs everything without asking"
  }
}

/** How much the agent may do without asking. */
function AccessPicker({ thread, onError }: ControlProps) {
  const theme = useTheme()
  const { current } = useThreadModels(thread)
  const colorOf = (mode: AccessMode) => (mode === "full" ? theme.danger : undefined)
  return (
    <Picker
      label="Access"
      icon={accessModes[thread.accessMode].icon}
      color={colorOf(thread.accessMode)}
      value={thread.accessMode}
      options={AccessMode.literals.map((mode) => ({
        value: mode,
        ...accessModes[mode],
        hint: accessHint(mode, thread, current),
        color: colorOf(mode),
      }))}
      onChange={(accessMode) => void update({ id: thread.id, accessMode }, onError)}
    />
  )
}

interface Option<T extends string> {
  readonly value: T
  readonly label: string
  readonly hint?: string
  readonly icon?: IconName
  readonly color?: string
}

/** A chip showing the current choice that opens a bottom sheet of options. */
function Picker<T extends string>({
  label,
  icon,
  color,
  value,
  options,
  onChange,
  shrink = false,
}: {
  label: string
  icon?: IconName
  color?: string
  value: T
  options: readonly Option<T>[]
  onChange: (value: T) => void
  shrink?: boolean
}) {
  const [open, setOpen] = useState(false)
  const select = (next: T) => {
    setOpen(false)
    if (next !== value) onChange(next)
  }
  return (
    <>
      <Chip
        label={label}
        text={options.find((option) => option.value === value)?.label ?? value}
        icon={icon}
        color={color}
        expandable
        shrink={shrink}
        onPress={() => setOpen(true)}
      />
      <Sheet title={label} open={open} onClose={() => setOpen(false)}>
        {options.map((option) => (
          <SheetOption key={option.value} option={option} selected={option.value === value} onPress={select} />
        ))}
      </Sheet>
    </>
  )
}

function Chip({
  label,
  text,
  icon,
  color,
  hint,
  selected,
  expandable = false,
  shrink = false,
  onPress,
}: {
  label: string
  text: string
  icon?: IconName
  color?: string
  hint?: string
  selected?: boolean
  expandable?: boolean
  shrink?: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const foreground = color ?? (selected ? theme.text : theme.textMuted)
  const slop = (HIT - CHIP_HEIGHT) / 2
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityValue={{ text }}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      hitSlop={{ top: slop, bottom: slop }}
      style={({ pressed }) => [
        styles.chip,
        shrink && styles.shrink,
        (selected || pressed) && { backgroundColor: theme.surfaceStrong },
        pressed && styles.pressed,
      ]}
    >
      {icon !== undefined && <Icon name={icon} size={14} color={foreground} />}
      <Text numberOfLines={1} style={[styles.chipLabel, shrink && styles.shrink, { color: foreground }]}>
        {text}
      </Text>
      {expandable && <Icon name="RiArrowDownSLine" size={12} color={theme.textMuted} />}
    </Pressable>
  )
}

function Sheet({
  title,
  open,
  onClose,
  children,
}: {
  title: string
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  return (
    <Modal transparent animationType="slide" visible={open} onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={[StyleSheet.absoluteFill, styles.backdrop]}
        />
        <View
          accessibilityViewIsModal
          accessibilityLabel={title}
          style={[
            styles.sheet,
            {
              backgroundColor: theme.background,
              borderColor: theme.border,
              paddingBottom: SHEET_PADDING + insets.bottom,
            },
          ]}
        >
          <Text accessibilityRole="header" style={[styles.sheetTitle, { color: theme.textMuted }]}>
            {title}
          </Text>
          <ScrollView style={{ maxHeight: height * 0.6 }} contentContainerStyle={styles.options}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

function SheetOption<T extends string>({
  option,
  selected,
  onPress,
}: {
  option: Option<T>
  selected: boolean
  onPress: (value: T) => void
}) {
  const theme = useTheme()
  const color = option.color ?? theme.text
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={option.label}
      accessibilityHint={option.hint}
      accessibilityState={{ checked: selected }}
      onPress={() => onPress(option.value)}
      style={({ pressed }) => [styles.option, pressed && { backgroundColor: theme.surface }]}
    >
      {option.icon !== undefined && <Icon name={option.icon} size={18} color={color} />}
      <View style={styles.optionText}>
        <Text style={[styles.optionLabel, { color }]}>{option.label}</Text>
        {option.hint !== undefined && (
          <Text style={[styles.optionHint, { color: theme.textMuted }]}>{option.hint}</Text>
        )}
      </View>
      {selected && <Icon name="RiCheckLine" size={18} color={theme.text} />}
    </Pressable>
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
  toolbar: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  controls: { flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
  chip: {
    height: CHIP_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    borderRadius: radius.full,
  },
  chipLabel: { fontSize: 12.5, fontWeight: "500" },
  shrink: { flexShrink: 1, minWidth: 0 },
  pressed: { transform: [{ scale: 0.96 }] },
  send: {
    width: SEND_SIZE,
    height: SEND_SIZE,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  error: { fontSize: 13, paddingHorizontal: 4 },
  sheetRoot: { flex: 1, justifyContent: "flex-end" },
  // The scrim is dark in both themes, so it borrows the dark palette's background.
  backdrop: { backgroundColor: Colors.dark.background, opacity: 0.5 },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: SHEET_PADDING,
  },
  options: { gap: 2 },
  sheetTitle: { fontSize: 13, fontWeight: "600", paddingHorizontal: 12, paddingVertical: 10 },
  option: {
    minHeight: HIT + 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.lg - SHEET_PADDING,
  },
  optionText: { flex: 1, gap: 2 },
  optionLabel: { fontSize: 15, fontWeight: "500" },
  optionHint: { fontSize: 13 },
})
