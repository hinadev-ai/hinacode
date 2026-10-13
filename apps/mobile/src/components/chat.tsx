import type { ApprovalDecision, ApprovalRequest, Question, QuestionAnswers, QuestionRequest } from "@shared/agent.ts"
import type { Message, MessagePart, Thread, ToolCallStatus } from "@shared/domain.ts"
import { useEffect, useMemo, useState } from "react"
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { Composer } from "@/components/composer"
import { Icon, type IconName } from "@/components/icon"
import { Button, Notice, Pill } from "@/components/ui"
import { HIT, mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { errorText } from "@/lib/error-text"
import { useMessages } from "@/stores/messages"

/** Cards hold insets with `radius.sm` corners, so the card's own corners stay concentric with them. */
const CARD_PADDING = 12

export function Chat({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const connected = useConnection((state) => state.status === "connected")
  const history = useMessages((state) => state.byThread[thread.id])

  useEffect(() => {
    if (connected && history === undefined) void useMessages.getState().load(thread.id)
  }, [connected, history, thread.id])

  const messages = history?.status === "ready" ? history.messages : undefined
  const newestFirst = useMemo(() => (messages === undefined ? [] : [...messages].reverse()), [messages])

  return (
    <View style={styles.flex}>
      {history?.status === "error" ? (
        <View style={styles.centered}>
          <Notice text={history.message} tone="danger" />
          <Button label="Retry" onPress={() => void useMessages.getState().load(thread.id)} />
        </View>
      ) : history?.status !== "ready" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.textMuted} accessibilityLabel="Loading transcript" />
        </View>
      ) : (
        <FlatList
          testID="transcript"
          accessibilityLabel="Transcript"
          inverted
          data={newestFirst}
          keyExtractor={(message) => message.id}
          renderItem={({ item }) => <MessageView message={item} />}
          contentContainerStyle={styles.transcript}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={[styles.empty, { color: theme.textMuted }]}>Send a prompt to start this thread.</Text>
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

function MessageView({ message }: { message: Message }) {
  const theme = useTheme()
  const user = message.role === "user"
  return (
    <View
      style={[
        styles.message,
        user && { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: StyleSheet.hairlineWidth },
      ]}
    >
      <Text style={[styles.role, { color: theme.textMuted }]}>{user ? "You" : "Agent"}</Text>
      {message.parts.map((part, index) => (
        <PartView key={index} part={part} />
      ))}
    </View>
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
    case "tool_call":
      return (
        <View style={[styles.tool, { borderColor: theme.border }]}>
          <Icon name="RiToolsLine" size={14} color={theme.textMuted} />
          <Text numberOfLines={1} style={[styles.toolName, { color: theme.text }]}>
            {part.name}
            {summarize(part.input) && <Text style={{ color: theme.textMuted }}> {summarize(part.input)}</Text>}
          </Text>
          <ToolStatus status={part.status} />
        </View>
      )
    case "file_change":
      return (
        <View style={styles.fileChange}>
          <Icon name="RiPencilLine" size={14} color={theme.textMuted} />
          <Text numberOfLines={1} style={[styles.toolName, { color: theme.textMuted }]}>
            Edited <Text style={{ color: theme.text }}>{part.path}</Text>
          </Text>
        </View>
      )
    case "attachment":
      return <Text style={{ color: theme.textMuted }}>Attached {part.attachment.name}</Text>
    case "questions":
      return <Text style={[styles.text, { color: theme.text }]}>{part.text}</Text>
  }
}

const toolStatus = {
  running: { label: "Running", tone: "running", icon: "RiLoader4Line" },
  error: { label: "Failed", tone: "danger", icon: "RiErrorWarningLine" },
  done: { label: "Done", tone: "neutral", icon: "RiCheckLine" },
} as const satisfies Record<ToolCallStatus, { label: string; tone: "running" | "danger" | "neutral"; icon: IconName }>

function ToolStatus({ status }: { status: ToolCallStatus }) {
  const theme = useTheme()
  const { label, tone, icon } = toolStatus[status]
  const color = tone === "running" ? theme.running : tone === "danger" ? theme.danger : theme.textMuted
  return (
    <View style={styles.status}>
      <Icon name={icon} size={14} color={color} />
      <Pill label={label} tone={tone} />
    </View>
  )
}

/** The one field that says what a tool call touched, when its input has one. */
function summarize(input: unknown) {
  if (typeof input !== "object" || input === null) return ""
  const record = input as Record<string, unknown>
  for (const key of ["command", "file_path", "path", "pattern", "url", "description"]) {
    const value = record[key]
    if (typeof value === "string") return value.split("\n")[0]
  }
  return ""
}

function Reasoning({ text }: { text: string }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Reasoning"
        onPress={() => setOpen(!open)}
        style={styles.disclosure}
      >
        <Icon name={open ? "RiArrowDownSLine" : "RiArrowRightSLine"} size={16} color={theme.textMuted} />
        <Text style={{ color: theme.textMuted, fontSize: 13 }}>{open ? "Hide reasoning" : "Reasoning"}</Text>
      </Pressable>
      {open && <Text style={[styles.text, { color: theme.textMuted }]}>{text}</Text>}
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

function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const theme = useTheme()
  const { busy, error, run } = useAction()
  const respond = (decision: ApprovalDecision) => () =>
    void run(() => call("approvals.respond", { requestId: request.id, decision }))
  return (
    <View
      testID="approval-card"
      accessibilityLabel={`Approval: ${request.title}`}
      style={[styles.card, { borderColor: theme.attention, backgroundColor: theme.attentionBg }]}
    >
      <Text style={[styles.cardTitle, { color: theme.text }]}>{request.title}</Text>
      {request.detail !== "" && (
        <Text numberOfLines={8} selectable style={[styles.detail, { color: theme.text, backgroundColor: theme.surface }]}>
          {request.detail}
        </Text>
      )}
      <View style={styles.actions}>
        <Button testID="approval-allow" label="Allow" variant="primary" busy={busy} onPress={respond("allow")} />
        <Button
          testID="approval-allow-session"
          label="Allow for session"
          disabled={busy}
          onPress={respond("allow_for_session")}
        />
        <Button testID="approval-deny" label="Deny" variant="danger" disabled={busy} onPress={respond("deny")} />
      </View>
      {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
    </View>
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
              accessibilityLabel={`Answer: ${question.question}`}
              value={typed[question.id] ?? ""}
              onChangeText={(text) => setTyped((current) => ({ ...current, [question.id]: text }))}
              secureTextEntry={question.secret}
              placeholder="Type an answer"
              placeholderTextColor={theme.textMuted}
              style={[styles.answer, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
            />
          )}
        </View>
      ))}
      <View style={styles.actions}>
        <Button
          testID="question-submit"
          label="Submit"
          variant="primary"
          busy={busy}
          disabled={Object.keys(answers).length === 0}
          onPress={() => respond(answers)}
        />
        <Button testID="question-skip" label="Skip" disabled={busy} onPress={() => respond({})} />
      </View>
      {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20, gap: 12 },
  transcript: { padding: 16, gap: 12 },
  empty: { textAlign: "center", padding: 24, fontSize: 15 },
  message: { gap: 6, borderRadius: radius.lg, padding: 12 },
  role: { fontSize: 12, fontWeight: "600" },
  text: { fontSize: 15, lineHeight: 22 },
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
