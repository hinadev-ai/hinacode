import type { ApprovalDecision, ApprovalRequest, Question, QuestionAnswers, QuestionRequest } from "@shared/agent.ts"
import type { Thread } from "@shared/domain.ts"
import type { UsageLimit } from "@shared/limits.ts"
import { type ReactNode, useState } from "react"
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { Icon } from "@/components/icon"
import { FadeIn } from "@/components/motion"
import { Button } from "@/components/ui"
import { duration, rise } from "@/constants/motion"
import { HIT, mono, radius, subheading } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy, locale } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { motion } from "@/lib/motion"
import { useThreads } from "@/stores/threads"

/** Cards hold insets with `radius.sm` corners, so the card's own corners stay concentric with them. */
const CARD_PADDING = 12

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

export function ApprovalCard({ request, header }: { request: ApprovalRequest; header?: ReactNode }) {
  const theme = useTheme()
  const { busy, error, run } = useAction()
  const [note, setNote] = useState("")
  const respond = (decision: ApprovalDecision) => () => {
    const trimmed = note.trim()
    void run(() =>
      call("approvals.respond", { requestId: request.id, decision, ...(trimmed !== "" && { note: trimmed }) }),
    )
  }
  return (
    <ResolvableCard>
      <View
        testID="approval-card"
        accessibilityLabel={copy("mobile_chat_approval", { title: request.title })}
        style={[styles.card, { borderColor: theme.attention, backgroundColor: theme.attentionBg }]}
      >
        {header}
        <Text style={[styles.cardTitle, { color: theme.text }]}>{request.title}</Text>
        {request.detail !== "" && (
          <Text selectable style={[styles.detail, { color: theme.text, backgroundColor: theme.surface }]}>
            {request.detail}
          </Text>
        )}
        <TextInput
          accessibilityLabel={copy("mobile_chat_approval_note_label")}
          value={note}
          onChangeText={setNote}
          editable={!busy}
          placeholder={copy("mobile_chat_approval_note_placeholder")}
          placeholderTextColor={theme.textMuted}
          style={[styles.answer, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
        />
        <View style={styles.actions}>
          <Button
            testID="approval-allow"
            label={copy("mobile_chat_allow")}
            variant="primary"
            busy={busy}
            onPress={respond("allow")}
            style={styles.cardButton}
          />
          <Button
            testID="approval-allow-session"
            label={copy("mobile_chat_allow_session")}
            disabled={busy}
            onPress={respond("allow_for_session")}
            style={styles.cardButton}
          />
          <Button
            testID="approval-deny"
            label={copy("mobile_chat_deny")}
            variant="danger"
            disabled={busy}
            onPress={respond("deny")}
            style={styles.cardButton}
          />
        </View>
        {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
      </View>
    </ResolvableCard>
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
    <ResolvableCard>
      <View
        testID="usage-limit"
        accessibilityRole="summary"
        style={[styles.card, { borderColor: theme.attention, backgroundColor: theme.attentionBg }]}
      >
        <View style={styles.cardHeading}>
          <Icon name="Warning" size={16} color={theme.attention} />
          <Text
            accessibilityRole="header"
            {...subheading}
            style={[styles.cardTitle, styles.shrink, { color: theme.attention }]}
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
              <Text style={[styles.cardNote, { color: theme.attention }]}>
                {copy("mobile_chat_usage_limit_scheduled")}
              </Text>
            )}
            <View style={styles.actions}>
              <Button
                testID="usage-limit-resume"
                label={copy(reset.autoResume ? "mobile_chat_usage_limit_cancel_resume" : "mobile_chat_usage_limit_resume")}
                busy={busy}
                onPress={() => setAutoResume(!reset.autoResume)}
                style={styles.cardButton}
              />
            </View>
          </>
        )}
        {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
      </View>
    </ResolvableCard>
  )
}

export function QuestionCard({ request, header }: { request: QuestionRequest; header?: ReactNode }) {
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
    <ResolvableCard>
      <View
        testID="question-card"
        style={[styles.card, { borderColor: theme.attention, backgroundColor: theme.attentionBg }]}
      >
        {header}
        {question !== undefined && (
          <FadeIn key={question.id} style={styles.question}>
            {!single && (
              <View style={styles.step}>
                <Text style={[styles.cardNote, { color: theme.textMuted }]}>
                  {copy("mobile_chat_question_step", { current: String(step + 1), total: String(total) })}
                </Text>
                {question.header !== "" && (
                  <Text style={[styles.cardNote, styles.shrink, { color: theme.textMuted }]}>{question.header}</Text>
                )}
              </View>
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
                    style={[
                      styles.option,
                      {
                        borderColor: selected ? theme.primary : theme.border,
                        backgroundColor: theme.surface,
                      },
                    ]}
                  >
                    <View style={styles.optionText}>
                      <Text style={{ color: theme.text, fontWeight: "600" }}>{option.label}</Text>
                      {option.description !== "" && (
                        <Text style={{ color: theme.textMuted, fontSize: 13 }}>{option.description}</Text>
                      )}
                    </View>
                    {selected && <Icon name="Check" size={18} color={theme.text} />}
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
        <View style={styles.actions}>
          {step > 0 && (
            <Button
              testID="question-back"
              label={copy("mobile_chat_back")}
              disabled={busy}
              onPress={() => setStep(step - 1)}
              style={styles.cardButton}
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
              style={styles.cardButton}
            />
          ) : (
            <Button
              testID="question-next"
              label={copy("mobile_chat_next")}
              variant="primary"
              disabled={busy}
              onPress={() => setStep(step + 1)}
              style={styles.cardButton}
            />
          )}
          <Button
            testID="question-skip"
            label={copy("mobile_chat_skip")}
            disabled={busy}
            onPress={() => respond({})}
            style={styles.cardButton}
          />
        </View>
        {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
      </View>
    </ResolvableCard>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: radius.sm + CARD_PADDING,
    padding: CARD_PADDING,
    gap: 10,
  },
  cardTitle: { fontSize: 15, fontWeight: "600" },
  cardHeading: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardBody: { fontSize: 15, lineHeight: 21 },
  cardNote: { fontSize: 13, lineHeight: 18 },
  cardButton: { borderRadius: radius.sm },
  shrink: { flexShrink: 1 },
  detail: { fontFamily: mono, fontSize: 12, padding: 8, borderRadius: radius.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" },
  question: { gap: 8 },
  step: { flexDirection: "row", gap: 8 },
  options: { gap: 6 },
  option: {
    minHeight: HIT,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: 10,
  },
  optionText: { flex: 1, gap: 2 },
  answer: {
    minHeight: HIT,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    fontSize: Platform.OS === "web" ? 16 : 15,
  },
})
