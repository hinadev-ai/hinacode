import type { ApprovalDecision, ApprovalRequest, Question, QuestionAnswers, QuestionRequest } from "@shared/agent.ts"
import type { Thread } from "@shared/domain.ts"
import type { UsageLimit } from "@shared/limits.ts"
import { type ReactNode, useState } from "react"
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { Icon } from "@/components/icon"
import { FadeIn, PressableScale, Rotate } from "@/components/motion"
import { Button } from "@/components/ui"
import { duration, rise } from "@/constants/motion"
import { HIT, mono, radius, subheading } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useTheme } from "@/hooks/use-theme"
import { approvalCommand } from "@/lib/approval-command"
import { call } from "@/lib/connection"
import { copy, locale } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { motion } from "@/lib/motion"
import { relativeTime } from "@/lib/relative-time"
import { useThreads } from "@/stores/threads"

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

function ResolvableCard({ children }: { children: ReactNode }) {
  return (
    <motion.View {...rise} exit={{ opacity: 0, transition: { duration: duration.fast } }} layout>
      {children}
    </motion.View>
  )
}

const AGE_FULL_MS = 10 * 60_000

function Ticket({
  testID,
  accessibilityLabel,
  accessibilityRole,
  since,
  ageBar = true,
  header,
  children,
}: {
  testID: string
  accessibilityLabel?: string
  accessibilityRole?: "summary"
  since?: string
  ageBar?: boolean
  header?: ReactNode
  children: ReactNode
}) {
  const theme = useTheme()
  const now = useNow()
  const waited = since === undefined ? AGE_FULL_MS : now - Date.parse(since)
  const filled = Math.min(1, Math.max(0, waited / AGE_FULL_MS))
  return (
    <ResolvableCard>
      <View
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole={accessibilityRole}
        style={[styles.card, { borderColor: theme.border, backgroundColor: theme.card }]}
      >
        {ageBar && (
          <View style={[styles.ageBar, { backgroundColor: theme.surface }]}>
            <View style={[styles.ageFill, { width: `${filled * 100}%`, backgroundColor: theme.attention }]} />
          </View>
        )}
        {header !== undefined && <View style={styles.header}>{header}</View>}
        <View style={styles.body}>{children}</View>
      </View>
    </ResolvableCard>
  )
}

function TicketHead({ label, since, note }: { label: string; since?: string; note?: string }) {
  const theme = useTheme()
  const now = useNow()
  return (
    <View style={styles.head}>
      <Text numberOfLines={2} style={[styles.headLabel, { color: theme.text }]}>
        {label}
      </Text>
      {note !== undefined && <Text style={[styles.cardNote, { color: theme.textMuted }]}>{note}</Text>}
      <View style={styles.spacer} />
      {since !== undefined && (
        <View style={styles.age}>
          <Icon name="Clock" size={14} color={theme.attention} />
          <Text style={[styles.ageText, { color: theme.attention }]}>{relativeTime(since, now)}</Text>
        </View>
      )}
    </View>
  )
}

export function ApprovalCard({
  request,
  header,
  since,
}: {
  request: ApprovalRequest
  header?: ReactNode
  since?: string
}) {
  const theme = useTheme()
  const { busy, error, run } = useAction()
  const [note, setNote] = useState("")
  const [moreShown, setMoreShown] = useState(false)
  const respond = (decision: ApprovalDecision) => () => {
    const trimmed = note.trim()
    void run(() =>
      call("approvals.respond", { requestId: request.id, decision, ...(trimmed !== "" && { note: trimmed }) }),
    )
  }
  const command = request.kind === "command"
  const shown = command ? approvalCommand(request) : { command: request.detail, note: "" }
  const block = shown.command
  return (
    <Ticket
      testID="approval-card"
      accessibilityLabel={copy("mobile_chat_approval", { title: request.title })}
      since={since}
      header={header}
    >
      <TicketHead
        label={command ? copy("mobile_chat_wants_to_run") : request.title}
        since={header === undefined ? since : undefined}
      />
      {shown.note !== "" && <Text style={[styles.cardNote, { color: theme.textMuted }]}>{shown.note}</Text>}
      {block !== "" && (
        <View style={[styles.command, { backgroundColor: theme.surface }]}>
          {command && <Text style={[styles.commandText, { color: theme.textMuted }]}>$</Text>}
          <Text selectable style={[styles.commandText, styles.shrink, { color: theme.text }]}>
            {block}
          </Text>
        </View>
      )}
      <View style={styles.decision}>
        <PressableScale
          testID="approval-deny"
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_chat_deny")}
          aria-disabled={busy}
          disabled={busy}
          onPress={respond("deny")}
          style={[styles.deny, { borderColor: theme.border, backgroundColor: theme.card }]}
        >
          <Icon name="Close" size={20} color={busy ? theme.textMuted : theme.text} />
        </PressableScale>
        <Button
          testID="approval-allow"
          label={copy("mobile_chat_approve")}
          icon="Check"
          variant="primary"
          busy={busy}
          onPress={respond("allow")}
          style={styles.approve}
        />
      </View>
      <Pressable
        testID="approval-more"
        accessibilityRole="button"
        aria-expanded={moreShown}
        onPress={() => setMoreShown(!moreShown)}
        hitSlop={8}
        style={styles.more}
      >
        <Text style={[styles.moreLabel, { color: theme.textMuted }]}>
          {copy(moreShown ? "mobile_chat_fewer_options" : "mobile_chat_more_options")}
        </Text>
        <Rotate turned={moreShown}>
          <Icon name="ChevronRight" size={14} color={theme.textMuted} />
        </Rotate>
      </Pressable>
      {moreShown && (
        <FadeIn style={styles.moreOptions}>
          <TextInput
            accessibilityLabel={copy("mobile_chat_approval_note_label")}
            value={note}
            onChangeText={setNote}
            editable={!busy}
            placeholder={copy("mobile_chat_approval_note_placeholder")}
            placeholderTextColor={theme.textMuted}
            style={[styles.answer, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
          />
          <Button
            testID="approval-allow-session"
            label={copy("mobile_chat_allow_session")}
            disabled={busy}
            onPress={respond("allow_for_session")}
            style={styles.pillButton}
          />
        </FadeIn>
      )}
      {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
    </Ticket>
  )
}

const formatResetTime = (at: string) => {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null
  return date.toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function UsageLimitCallout({ thread, limit }: { thread: Thread; limit: UsageLimit }) {
  const theme = useTheme()
  const { busy, error, run } = useAction()
  const { reset } = limit
  const resetTime = reset === null ? null : formatResetTime(reset.at)
  const setAutoResume = (enabled: boolean) =>
    void run(async () => useThreads.getState().upsert(await call("threads.resumeAtReset", { id: thread.id, enabled })))
  return (
    <Ticket testID="usage-limit" accessibilityRole="summary" ageBar={false}>
      <View style={styles.cardHeading}>
        <Icon name="Warning" size={16} color={theme.attention} />
        <Text
          accessibilityRole="header"
          {...subheading}
          style={[styles.headLabel, styles.shrink, { color: theme.attention }]}
        >
          {copy(limit.kind === "org_spend" ? "mobile_chat_org_spend_limit_title" : "mobile_chat_usage_limit_title")}
        </Text>
      </View>
      <Text selectable style={[styles.cardBody, { color: theme.text }]}>
        {limit.message}
      </Text>
      {limit.kind === "org_spend" && (
        <Text style={[styles.cardNote, { color: theme.textMuted }]}>{copy("mobile_chat_org_spend_limit_hint")}</Text>
      )}
      {reset !== null && resetTime !== null && (
        <>
          <Text style={[styles.cardNote, { color: theme.textMuted }]}>
            {copy("mobile_chat_usage_limit_reset", { time: resetTime })}
          </Text>
          {reset.autoResume && (
            <Text style={[styles.cardNote, { color: theme.attention }]}>{copy("mobile_chat_usage_limit_scheduled")}</Text>
          )}
          <View style={styles.actions}>
            <Button
              testID="usage-limit-resume"
              label={copy(reset.autoResume ? "mobile_chat_usage_limit_cancel_resume" : "mobile_chat_usage_limit_resume")}
              busy={busy}
              onPress={() => setAutoResume(!reset.autoResume)}
              style={styles.pillButton}
            />
          </View>
        </>
      )}
      {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
    </Ticket>
  )
}

export function QuestionCard({
  request,
  header,
  since,
}: {
  request: QuestionRequest
  header?: ReactNode
  since?: string
}) {
  const theme = useTheme()
  const { busy, error, run } = useAction()
  const [picked, setPicked] = useState<Readonly<Record<string, readonly string[]>>>({})
  const [typed, setTyped] = useState<Readonly<Record<string, string>>>({})
  const [step, setStep] = useState(0)

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

  const total = request.questions.length
  const single = total === 1
  const last = step >= total - 1
  const question = request.questions[step]

  const pick = (question: Question, label: string) => {
    toggle(question, label)
    const typedNothing = (typed[question.id]?.trim() ?? "") === ""
    if (!question.multiSelect && !last && typedNothing) setStep(step + 1)
  }

  return (
    <Ticket testID="question-card" since={since} header={header}>
      <TicketHead
        label={copy("mobile_chat_has_question")}
        note={single ? undefined : copy("mobile_chat_question_step", { current: String(step + 1), total: String(total) })}
        since={header === undefined ? since : undefined}
      />
      {question !== undefined && (
        <FadeIn key={question.id} style={styles.question}>
          {!single && question.header !== "" && (
            <Text style={[styles.cardNote, { color: theme.textMuted }]}>{question.header}</Text>
          )}
          <Text style={[styles.cardTitle, { color: theme.text }]}>
            {single && question.header !== "" ? `${question.header}: ` : ""}
            {question.question}
          </Text>
          <View style={styles.options}>
            {question.options.map((option) => {
              const selected = picked[question.id]?.includes(option.label) ?? false
              return (
                <Pressable
                  key={option.label}
                  accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                  aria-checked={selected}
                  accessibilityLabel={option.label}
                  accessibilityHint={option.description}
                  onPress={() => pick(question, option.label)}
                  style={({ pressed }) => [
                    styles.option,
                    {
                      borderColor: selected ? theme.primary : theme.border,
                      backgroundColor: pressed ? theme.surfaceStrong : theme.surface,
                    },
                  ]}
                >
                  {selected && <Icon name="Check" size={16} color={theme.primary} />}
                  <View style={styles.shrink}>
                    <Text style={[styles.optionLabel, { color: theme.text }]}>{option.label}</Text>
                    {option.description !== "" && (
                      <Text style={[styles.optionDescription, { color: theme.textMuted }]}>{option.description}</Text>
                    )}
                  </View>
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
        </FadeIn>
      )}
      <View style={styles.decision}>
        {step > 0 && (
          <Button
            testID="question-back"
            label={copy("mobile_chat_back")}
            disabled={busy}
            onPress={() => setStep(step - 1)}
            style={styles.pillButton}
          />
        )}
        {last ? (
          <Button
            testID="question-submit"
            label={copy("mobile_chat_submit")}
            variant="primary"
            busy={busy}
            disabled={Object.keys(answers).length === 0}
            onPress={() => respond(answers)}
            style={styles.approve}
          />
        ) : (
          <Button
            testID="question-next"
            label={copy("mobile_chat_next")}
            variant="primary"
            disabled={busy}
            onPress={() => setStep(step + 1)}
            style={styles.approve}
          />
        )}
      </View>
      <Pressable
        testID="question-skip"
        accessibilityRole="button"
        accessibilityLabel={copy("mobile_chat_skip")}
        aria-disabled={busy}
        disabled={busy}
        onPress={() => respond({})}
        hitSlop={8}
        style={styles.more}
      >
        <Text style={[styles.moreLabel, { color: theme.textMuted }]}>{copy("mobile_chat_skip")}</Text>
      </Pressable>
      {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
    </Ticket>
  )
}

const CARD_RADIUS = 16
const CARD_PADDING = 16
const DECISION_HEIGHT = 52
const CONTROL_RADIUS = radius.md

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: CARD_RADIUS,
    overflow: "hidden",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.06)",
  },
  ageBar: { height: 4 },
  ageFill: { height: "100%" },
  header: { paddingHorizontal: CARD_PADDING, paddingTop: CARD_PADDING },
  body: { padding: CARD_PADDING, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  headLabel: { flexShrink: 1, fontSize: 16, fontWeight: "600" },
  spacer: { flex: 1 },
  age: { flexDirection: "row", alignItems: "center", gap: 4 },
  ageText: { fontFamily: mono, fontSize: 13, fontVariant: ["tabular-nums"] },
  cardTitle: { fontSize: 15, fontWeight: "600" },
  cardHeading: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardBody: { fontSize: 15, lineHeight: 21 },
  cardNote: { fontSize: 13, lineHeight: 18 },
  shrink: { flexShrink: 1 },
  command: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: CONTROL_RADIUS,
  },
  commandText: { fontFamily: mono, fontSize: 14, lineHeight: 20 },
  decision: { flexDirection: "row", alignItems: "center", gap: 10 },
  deny: {
    width: DECISION_HEIGHT,
    height: DECISION_HEIGHT,
    borderRadius: CONTROL_RADIUS,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  approve: { flex: 1, minHeight: DECISION_HEIGHT, borderRadius: CONTROL_RADIUS },
  pillButton: { minHeight: DECISION_HEIGHT, borderRadius: CONTROL_RADIUS },
  actions: { gap: 8 },
  more: { minHeight: HIT, flexDirection: "row", alignItems: "center", alignSelf: "center", gap: 4, marginVertical: -8 },
  moreLabel: { fontSize: 13, fontWeight: "500" },
  moreOptions: { gap: 10 },
  question: { gap: 10 },
  options: { gap: 8 },
  option: {
    minHeight: HIT,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: CONTROL_RADIUS,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  optionLabel: { fontSize: 15, fontWeight: "600" },
  optionDescription: { fontSize: 12, lineHeight: 16 },
  answer: {
    minHeight: HIT,
    borderWidth: 1,
    borderRadius: CONTROL_RADIUS,
    paddingHorizontal: 12,
    fontSize: Platform.OS === "web" ? 16 : 15,
  },
})
