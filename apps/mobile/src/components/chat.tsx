import type {
  ApprovalDecision,
  ApprovalRequest,
  Compaction,
  Question,
  QuestionAnswers,
  QuestionRequest,
} from "@shared/agent.ts"
import { toolSummary } from "@shared/compactTranscript.ts"
import type { Message, MessagePart, Thread, ToolCallStatus } from "@shared/domain.ts"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { Composer } from "@/components/composer"
import { Icon, type IconName } from "@/components/icon"
import { Markdown } from "@/components/markdown"
import { FadeIn, Rotate, Spinner } from "@/components/motion"
import { Button, Notice, Pill } from "@/components/ui"
import { cssEase, duration, rise } from "@/constants/motion"
import { HIT, mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { motion } from "@/lib/motion"
import { useMessages } from "@/stores/messages"
import { useThreadRoot } from "@/stores/threads"

/** Cards hold insets with `radius.sm` corners, so the card's own corners stay concentric with them. */
const CARD_PADDING = 12

type CopyKey = Parameters<typeof copy>[0]

// An inverted list flips each cell with `scaleY: -1`, so a message rises from a negative `y`.
const risesInFlippedCell = { ...rise.initial, y: -rise.initial.y }

export function Chat({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const connected = useConnection((state) => state.status === "connected")
  const history = useMessages((state) => state.byThread[thread.id])
  const root = useThreadRoot(thread)

  useEffect(() => {
    if (connected && history === undefined) void useMessages.getState().load(thread.id)
  }, [connected, history, thread.id])

  const messages = history?.status === "ready" ? history.messages : undefined
  const [openedNewest, setOpenedNewest] = useState<string | null>()
  if (messages !== undefined && openedNewest === undefined) setOpenedNewest(messages.at(-1)?.id ?? null)
  const openedAt = messages?.findIndex((message) => message.id === openedNewest) ?? -1
  const newestFirst = useMemo(() => (messages === undefined ? [] : [...messages].reverse()), [messages])
  const arrivedAfterOpening = (newestFirstIndex: number) => newestFirst.length - 1 - newestFirstIndex > openedAt

  return (
    <View style={styles.flex}>
      {history?.status === "error" ? (
        <View style={styles.centered}>
          <Notice text={history.message} tone="danger" />
          <Button label={copy("mobile_chat_retry")} onPress={() => void useMessages.getState().load(thread.id)} />
        </View>
      ) : history?.status !== "ready" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.textMuted} accessibilityLabel={copy("mobile_chat_loading")} />
        </View>
      ) : (
        <FlatList
          testID="transcript"
          accessibilityLabel={copy("mobile_chat_transcript")}
          inverted
          data={newestFirst}
          keyExtractor={(message) => message.id}
          renderItem={({ item, index }) => (
            <motion.View
              initial={arrivedAfterOpening(index) && risesInFlippedCell}
              animate={rise.animate}
            >
              <MessageView message={item} root={root} />
            </motion.View>
          )}
          // A rendered reply can hold hundreds of views, so the list mounts a screenful first and the rest in small
          // batches instead of ten whole messages in one frame.
          initialNumToRender={4}
          maxToRenderPerBatch={2}
          windowSize={9}
          contentContainerStyle={styles.transcript}
          keyboardShouldPersistTaps="handled"
          // Inverted, so the end is the top: scrolling up to the oldest message reads the page before it.
          onEndReached={() => void useMessages.getState().loadEarlier(thread.id)}
          onEndReachedThreshold={1}
          ListFooterComponent={
            history.loadingEarlier ? (
              <ActivityIndicator
                style={styles.earlier}
                color={theme.textMuted}
                accessibilityLabel={copy("mobile_chat_loading")}
              />
            ) : null
          }
          ListEmptyComponent={
            <Text style={[styles.empty, { color: theme.textMuted }]}>{copy("mobile_chat_empty")}</Text>
          }
        />
      )}
      {history?.status === "ready" && (
        <>
          {history.approvals.map((request) => (
            <ApprovalCard key={request.id} request={request} />
          ))}
          {history.questions.map((request) => (
            <QuestionCard key={request.id} request={request} />
          ))}
        </>
      )}
      <Composer thread={thread} />
    </View>
  )
}

function MessageView({ message, root }: { message: Message; root: string | null }) {
  const theme = useTheme()
  if (message.role !== "user") return <AssistantMessage message={message} root={root} />
  return (
    <View style={[styles.message, styles.user, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Text style={[styles.role, { color: theme.textMuted }]}>{copy("mobile_chat_you")}</Text>
      {message.parts.map((part, index) => (
        <PartView key={index} part={part} />
      ))}
    </View>
  )
}

/** A sub-agent's tool calls belong to its own transcript, which the phone does not show. */
const isOwnPart = (part: MessagePart) => part.type !== "tool_call" || part.parentCallId === undefined

/** Reasoning, tool calls and file changes. A finished response folds them behind its Worked for row. */
const isActivity = (part: MessagePart) =>
  part.type === "reasoning" || part.type === "tool_call" || part.type === "file_change"

const twoDigits = (value: number) => String(value).padStart(2, "0")

/** `mm:ss`, or `h:mm:ss` past an hour, like the desktop. */
function formatWorkDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
    : `${twoDigits(minutes)}:${twoDigits(seconds)}`
}

function AssistantMessage({ message, root }: { message: Message; root: string | null }) {
  const theme = useTheme()
  const [activityShown, setActivityShown] = useState(false)
  const parts = message.parts.filter(isOwnPart)
  const { completedAt } = message
  const streaming = completedAt === null
  const durationMs = completedAt === null ? NaN : Date.parse(completedAt) - Date.parse(message.createdAt)
  const folded = durationMs >= 0
  // A steer sent before the agent said anything closes an empty assistant message.
  if (!streaming && parts.length === 0) return null
  const writingIndex = streaming && parts.at(-1)?.type === "text" ? parts.length - 1 : undefined
  return (
    <View accessibilityState={{ busy: streaming }} style={styles.message}>
      <Text style={[styles.role, { color: theme.textMuted }]}>{copy("mobile_chat_agent")}</Text>
      {folded && (
        <WorkedFor
          durationMs={durationMs}
          expanded={activityShown}
          onToggle={parts.some(isActivity) ? () => setActivityShown(!activityShown) : undefined}
        />
      )}
      {parts.map((part, index) => {
        if (folded && isActivity(part)) {
          return activityShown ? (
            <FadeIn key={index}>
              <PartView part={part} />
            </FadeIn>
          ) : null
        }
        if (part.type === "text") {
          return (
            <ReplyText
              key={index}
              text={part.text}
              done={index !== writingIndex}
              root={root}
              threadId={message.threadId}
            />
          )
        }
        return <PartView key={index} part={part} />
      })}
      {streaming && (parts.length === 0 || writingIndex !== undefined) && (
        <Pulse text={copy(writingIndex !== undefined ? "mobile_chat_writing" : "mobile_chat_thinking")} />
      )}
    </View>
  )
}

/**
 * Reply text appears whole once the agent has finished it, instead of word by word. Only text that finishes while
 * on screen fades in, so opening a thread or scrolling back does not replay it.
 */
function ReplyText({
  text,
  done,
  root,
  threadId,
}: {
  text: string
  done: boolean
  root: string | null
  threadId: string
}) {
  const [finishedOnScreen] = useState(!done)
  if (!done) return null
  return (
    <FadeIn enabled={finishedOnScreen}>
      <Markdown text={text} root={root} threadId={threadId} />
    </FadeIn>
  )
}

const pulse = { "50%": { opacity: 0.5 } }

/** The desktop's `animate-pulse` line under a streaming reply. Reduce motion holds it still. */
function Pulse({ text }: { text: string }) {
  const theme = useTheme()
  const reduced = useReducedMotion()
  return (
    <Animated.View
      style={
        reduced
          ? undefined
          : {
              animationName: pulse,
              animationDuration: 2000,
              animationIterationCount: "infinite",
              animationTimingFunction: cssEase.pulse,
            }
      }
    >
      <Text style={[styles.pulse, { color: theme.textMuted }]}>{text}</Text>
    </Animated.View>
  )
}

/** Elapsed time of a finished response. With `onToggle`, it also shows and hides the response's activity. */
function WorkedFor({
  durationMs,
  expanded,
  onToggle,
}: {
  durationMs: number
  expanded: boolean
  onToggle: (() => void) | undefined
}) {
  const theme = useTheme()
  const label = copy("mobile_chat_worked_for", { duration: formatWorkDuration(durationMs) })
  const row = [styles.workedFor, { borderColor: theme.border }]
  const text = <Text style={[styles.workedForText, { color: theme.textMuted }]}>{label}</Text>
  if (onToggle === undefined) return <View style={row}>{text}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={copy(expanded ? "mobile_chat_hide_activity" : "mobile_chat_show_activity")}
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={row}
    >
      {text}
      <Rotate turned={expanded}>
        <Icon name="RiArrowRightSLine" size={14} color={theme.textMuted} />
      </Rotate>
    </Pressable>
  )
}

function PartView({ part }: { part: MessagePart }) {
  const theme = useTheme()
  switch (part.type) {
    case "text":
      return (
        <Text selectable style={[styles.text, { color: theme.text }]}>
          {part.text}
        </Text>
      )
    case "reasoning":
      return <Reasoning text={part.text} />
    case "tool_call": {
      const summary = toolSummary(part.input)?.line
      return (
        <View style={[styles.tool, { borderColor: theme.border }]}>
          <Icon name="RiToolsLine" size={14} color={theme.textMuted} />
          <Text numberOfLines={1} style={[styles.toolName, { color: theme.text }]}>
            {part.name}
            {summary && <Text style={{ color: theme.textMuted }}> {summary}</Text>}
          </Text>
          <ToolStatus status={part.status} />
        </View>
      )
    }
    case "file_change":
      return (
        <View style={styles.fileChange}>
          <Icon name="RiPencilLine" size={14} color={theme.textMuted} />
          <Text numberOfLines={1} style={[styles.toolName, { color: theme.textMuted }]}>
            {copy("mobile_chat_edited", { path: part.path })}
          </Text>
        </View>
      )
    case "attachment":
      return (
        <Text style={{ color: theme.textMuted }}>{copy("mobile_chat_attached", { name: part.attachment.name })}</Text>
      )
    case "questions":
      return <Text style={[styles.text, { color: theme.text }]}>{part.text}</Text>
    case "compaction":
      return (
        <Text style={{ color: part.compaction.status === "failed" ? theme.danger : theme.textMuted }}>
          {copy(compactionCopy[part.compaction.status])}
        </Text>
      )
  }
}

const compactionCopy = {
  running: "mobile_chat_compacting",
  done: "mobile_chat_compacted",
  failed: "mobile_chat_compaction_failed",
} as const satisfies Record<Compaction["status"], CopyKey>

const toolStatus = {
  running: { label: "mobile_chat_tool_running", tone: "running", icon: "RiLoader4Line" },
  error: { label: "mobile_chat_tool_failed", tone: "danger", icon: "RiErrorWarningLine" },
  done: { label: "mobile_chat_tool_done", tone: "neutral", icon: "RiCheckLine" },
} as const satisfies Record<ToolCallStatus, { label: CopyKey; tone: "running" | "danger" | "neutral"; icon: IconName }>

function ToolStatus({ status }: { status: ToolCallStatus }) {
  const theme = useTheme()
  const { label, tone, icon } = toolStatus[status]
  const color = tone === "running" ? theme.running : tone === "danger" ? theme.danger : theme.textMuted
  return (
    <View style={styles.status}>
      {status === "running" ? <Spinner size={14} color={color} /> : <Icon name={icon} size={14} color={color} />}
      <Pill label={copy(label)} tone={tone} />
    </View>
  )
}

function Reasoning({ text }: { text: string }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={copy("mobile_chat_reasoning")}
        onPress={() => setOpen(!open)}
        style={styles.disclosure}
      >
        <Rotate turned={open}>
          <Icon name="RiArrowRightSLine" size={16} color={theme.textMuted} />
        </Rotate>
        <Text style={{ color: theme.textMuted, fontSize: 13 }}>
          {copy(open ? "mobile_chat_hide_reasoning" : "mobile_chat_reasoning")}
        </Text>
      </Pressable>
      {open && (
        <FadeIn>
          <Text selectable style={[styles.text, { color: theme.textMuted }]}>
            {text}
          </Text>
        </FadeIn>
      )}
    </View>
  )
}

function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    let ok = true
    try {
      await action()
    } catch (cause) {
      setError(errorText(cause))
      ok = false
    }
    setBusy(false)
    return ok
  }
  return { busy, error, run }
}

/** A request rises in, fades out once answered, and the cards still waiting slide into its place. */
function ResolvableCard({ children }: { children: ReactNode }) {
  return (
    <motion.View {...rise} exit={{ opacity: 0, transition: { duration: duration.fast } }} layout>
      {children}
    </motion.View>
  )
}

function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const theme = useTheme()
  const { busy, error, run } = useAction()
  const respond = (decision: ApprovalDecision) => () =>
    void run(() => call("approvals.respond", { requestId: request.id, decision }))
  return (
    <ResolvableCard>
      <View
        testID="approval-card"
        accessibilityLabel={copy("mobile_chat_approval", { title: request.title })}
        style={[styles.card, { borderColor: theme.attention, backgroundColor: theme.attentionBg }]}
      >
        <Text style={[styles.cardTitle, { color: theme.text }]}>{request.title}</Text>
        {request.detail !== "" && (
          <Text
            numberOfLines={8}
            selectable
            style={[styles.detail, { color: theme.text, backgroundColor: theme.surface }]}
          >
            {request.detail}
          </Text>
        )}
        <View style={styles.actions}>
          <Button
            testID="approval-allow"
            label={copy("mobile_chat_allow")}
            variant="primary"
            busy={busy}
            onPress={respond("allow")}
          />
          <Button
            testID="approval-allow-session"
            label={copy("mobile_chat_allow_session")}
            disabled={busy}
            onPress={respond("allow_for_session")}
          />
          <Button
            testID="approval-deny"
            label={copy("mobile_chat_deny")}
            variant="danger"
            disabled={busy}
            onPress={respond("deny")}
          />
        </View>
        {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
      </View>
    </ResolvableCard>
  )
}

function QuestionCard({ request }: { request: QuestionRequest }) {
  const theme = useTheme()
  const { busy, error, run } = useAction()
  const [picked, setPicked] = useState<Readonly<Record<string, readonly string[]>>>({})
  const [typed, setTyped] = useState<Readonly<Record<string, string>>>({})

  const answers: QuestionAnswers = Object.fromEntries(
    request.questions
      .map((question) => {
        const text = typed[question.id]?.trim() ?? ""
        const options = picked[question.id] ?? []
        return [question.id, text === "" ? options : [...options, text]] as const
      })
      .filter(([, answer]) => answer.length > 0),
  )
  const respond = (value: QuestionAnswers) =>
    void run(() => call("questions.respond", { requestId: request.id, answers: value }))

  const toggle = (question: Question, label: string) =>
    setPicked((current) => {
      const selected = current[question.id] ?? []
      const next = question.multiSelect
        ? selected.includes(label)
          ? selected.filter((item) => item !== label)
          : [...selected, label]
        : [label]
      return { ...current, [question.id]: next }
    })

  return (
    <ResolvableCard>
      <View
        testID="question-card"
        style={[styles.card, { borderColor: theme.attention, backgroundColor: theme.attentionBg }]}
      >
        {request.questions.map((question) => (
          <View key={question.id} style={styles.question}>
            <Text style={[styles.cardTitle, { color: theme.text }]}>
              {question.header !== "" ? `${question.header}: ` : ""}
              {question.question}
            </Text>
            <View style={styles.options}>
              {question.options.map((option) => {
                const selected = picked[question.id]?.includes(option.label) ?? false
                return (
                  <Pressable
                    key={option.label}
                    accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={option.label}
                    accessibilityHint={option.description}
                    onPress={() => toggle(question, option.label)}
                    style={[
                      styles.option,
                      {
                        borderColor: selected ? theme.primary : theme.border,
                        backgroundColor: theme.surface,
                      },
                    ]}
                  >
                    <Text style={{ color: theme.text, fontWeight: "600" }}>{option.label}</Text>
                    {option.description !== "" && (
                      <Text style={{ color: theme.textMuted, fontSize: 13 }}>{option.description}</Text>
                    )}
                  </Pressable>
                )
              })}
            </View>
            {question.allowsText && (
              <TextInput
                accessibilityLabel={copy("mobile_chat_answer_label", { question: question.question })}
                value={typed[question.id] ?? ""}
                onChangeText={(text) => setTyped((current) => ({ ...current, [question.id]: text }))}
                secureTextEntry={question.secret}
                placeholder={copy("mobile_chat_answer_placeholder")}
                placeholderTextColor={theme.textMuted}
                style={[styles.answer, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
              />
            )}
          </View>
        ))}
        <View style={styles.actions}>
          <Button
            testID="question-submit"
            label={copy("mobile_chat_submit")}
            variant="primary"
            busy={busy}
            disabled={Object.keys(answers).length === 0}
            onPress={() => respond(answers)}
          />
          <Button testID="question-skip" label={copy("mobile_chat_skip")} disabled={busy} onPress={() => respond({})} />
        </View>
        {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
      </View>
    </ResolvableCard>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20, gap: 12 },
  transcript: { padding: 16, gap: 12 },
  earlier: { paddingVertical: 12 },
  empty: { textAlign: "center", padding: 24, fontSize: 15 },
  message: { gap: 6, borderRadius: radius.lg, padding: 12 },
  user: { borderWidth: StyleSheet.hairlineWidth },
  role: { fontSize: 12, fontWeight: "600" },
  text: { fontSize: 15, lineHeight: 22 },
  pulse: { fontSize: 12 },
  workedFor: {
    minHeight: HIT,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  workedForText: { fontSize: 12, fontVariant: ["tabular-nums"] },
  tool: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  toolName: { flex: 1, fontFamily: mono, fontSize: 13 },
  fileChange: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8 },
  status: { flexDirection: "row", alignItems: "center", gap: 4 },
  disclosure: { minHeight: HIT, flexDirection: "row", alignItems: "center", gap: 4 },
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: radius.sm + CARD_PADDING,
    padding: CARD_PADDING,
    gap: 10,
  },
  cardTitle: { fontSize: 15, fontWeight: "600" },
  detail: { fontFamily: mono, fontSize: 12, padding: 8, borderRadius: radius.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" },
  question: { gap: 8 },
  options: { gap: 6 },
  option: { minHeight: HIT, borderWidth: 1, borderRadius: radius.sm, padding: 10, justifyContent: "center", gap: 2 },
  answer: { minHeight: HIT, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 10 },
})
