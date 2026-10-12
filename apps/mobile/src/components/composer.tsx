import { type ModelInfo, ProviderId, unlistedModel } from "@shared/agent.ts"
import type { RpcRequest } from "@shared/contract.ts"
import { AccessMode, isThreadBusy, type Thread } from "@shared/domain.ts"
import { type ReactNode, useEffect, useState } from "react"
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Icon, type IconName } from "@/components/icon"
import { IconButton } from "@/components/ui"
import { Colors, HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { useDrafts } from "@/stores/drafts"
import { useMessages } from "@/stores/messages"
import { useModels } from "@/stores/models"
import { useThreads } from "@/stores/threads"

export const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

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
const SHEET_PADDING = 8

export function Composer({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const text = useDrafts((state) => state.byThreadId[thread.id] ?? "")
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
          <SettingsChip thread={thread} onError={setError} />
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
  const insets = useSafeAreaInsets()
  const { models, current } = useThreadModels(thread)
  // Agent stays open to change until the first message, as on the desktop.
  const unstarted = useMessages((state) => {
    const history = state.byThread[thread.id]
    return history?.status === "ready" && history.messages.length === 0 && thread.worktreeId === null
  })

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
    <Modal transparent animationType="slide" visible={open} onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={[styles.backdrop, { height: insets.top + 12 }]}
      />
      <View
        accessibilityViewIsModal
        style={[
          styles.sheet,
          {
            paddingBottom: SHEET_PADDING + insets.bottom,
            backgroundColor: theme.background,
            borderColor: theme.border,
          },
        ]}
      >
        <View style={styles.sheetHeader}>
          <Text accessibilityRole="header" style={[styles.sheetTitle, { color: theme.text }]}>
            Thread settings
          </Text>
          <IconButton icon="RiCloseLine" accessibilityLabel="Close" onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={styles.sections}>
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
              <View style={styles.option}>
                <Icon name="RiFlashlightLine" size={18} color={theme.text} />
                <View style={styles.optionText}>
                  <Text style={[styles.optionLabel, { color: theme.text }]}>Fast mode</Text>
                  <Text style={[styles.optionHint, { color: theme.textMuted }]}>
                    Faster responses that use more of your plan
                  </Text>
                </View>
                <Switch
                  accessibilityLabel="Fast mode"
                  value={thread.fastMode}
                  onValueChange={(fastMode) => void update({ id: thread.id, fastMode }, onError)}
                  trackColor={{ true: theme.primary, false: theme.surfaceStrong }}
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
        </ScrollView>
      </View>
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme()
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={title} style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>{title}</Text>
      {children}
    </View>
  )
}

function OptionRow({
  label,
  hint,
  icon,
  color,
  selected,
  onPress,
}: {
  label: string
  hint?: string
  icon?: IconName
  color?: string
  selected: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const foreground = color ?? theme.text
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.option, (pressed || selected) && { backgroundColor: theme.surface }]}
    >
      {icon !== undefined && <Icon name={icon} size={18} color={foreground} />}
      <View style={styles.optionText}>
        <Text style={[styles.optionLabel, { color: foreground }]}>{label}</Text>
        {hint !== undefined && <Text style={[styles.optionHint, { color: theme.textMuted }]}>{hint}</Text>}
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
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
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
  // The scrim is dark in both themes, so it borrows the dark palette's background.
  backdrop: { backgroundColor: Colors.dark.background, opacity: 0.5 },
  sheet: {
    flex: 1,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: SHEET_PADDING,
  },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 12 },
  sheetTitle: { fontSize: 16, fontWeight: "600" },
  sections: { gap: 16, paddingTop: 4 },
  section: { gap: 2 },
  sectionTitle: { fontSize: 13, fontWeight: "600", paddingHorizontal: 12, paddingVertical: 6 },
  option: {
    minHeight: HIT + 4,
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
