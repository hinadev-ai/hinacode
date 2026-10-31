import { type FormEvent, startTransition, useActionState, useId, useState } from "react"
import type { Question, QuestionAnswers, QuestionRequest } from "../../shared/agent.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"
import { Checkbox } from "./ui/checkbox.tsx"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "./ui/field.tsx"
import { Input } from "./ui/input.tsx"
import { RadioGroup, RadioGroupItem } from "./ui/radio-group.tsx"
import { QuestionIcon } from "./icons/QuestionIcon.tsx"

type Draft = { readonly picked: ReadonlyArray<string>; readonly text: string }

const EMPTY_DRAFT: Draft = { picked: [], text: "" }

const draftFor = (drafts: Readonly<Record<string, Draft>>, id: string): Draft =>
  Object.hasOwn(drafts, id) ? (drafts[id] ?? EMPTY_DRAFT) : EMPTY_DRAFT

const draftAnswer = (draft: Draft) => {
  const text = draft.text.trim()
  return text === "" ? draft.picked : [...draft.picked, text]
}

export function QuestionRequestCard({ request, providerLabel }: { request: QuestionRequest; providerLabel: string }) {
  return (
    <QuestionCard
      questions={request.questions}
      providerLabel={providerLabel}
      onAnswer={(answers) => callPromise("questions.respond", { requestId: request.id, answers })}
    />
  )
}

export function PostedQuestionsCard({
  threadId,
  questions,
  providerLabel,
}: {
  threadId: string
  questions: ReadonlyArray<Question>
  providerLabel: string
}) {
  return (
    <QuestionCard
      questions={questions}
      providerLabel={providerLabel}
      onAnswer={(answers) => callPromise("threads.steer", { threadId, text: answerText(questions, answers) })}
    />
  )
}

export const answerText = (questions: ReadonlyArray<Question>, answers: QuestionAnswers) =>
  questions
    .map((question) => {
      const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined
      return `${question.question}\n${answer?.join(", ") ?? "(skipped)"}`
    })
    .join("\n\n")

function QuestionCard({
  questions,
  providerLabel,
  onAnswer,
}: {
  questions: ReadonlyArray<Question>
  providerLabel: string
  onAnswer: (answers: QuestionAnswers) => Promise<void>
}) {
  const titleId = useId()
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({})
  const [error, respond, isPending] = useActionState(async (_: string | null, answers: QuestionAnswers) => {
    try {
      await onAnswer(answers)
      return null
    } catch (cause) {
      return errorMessage(cause)
    }
  }, null)

  const answers: QuestionAnswers = Object.fromEntries(
    questions
      .map((question) => [question.id, draftAnswer(draftFor(drafts, question.id))] as const)
      .filter(([, answer]) => answer.length > 0),
  )
  const answeredCount = Object.keys(answers).length
  const single = questions.length === 1

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (answeredCount === 0) return
    startTransition(() => respond(answers))
  }

  return (
    <section
      aria-labelledby={titleId}
      className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-3 rounded-xl border border-attention/40 bg-attention/5 p-3 transition-[opacity,translate] duration-200 ease-out starting:opacity-0 motion-safe:starting:translate-y-1"
    >
      <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
        <QuestionIcon aria-hidden className="size-4 text-attention" />
        {single
          ? m.question_title({ provider: providerLabel })
          : m.question_title_many({ provider: providerLabel, count: questions.length })}
      </h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {questions.map((question) => (
          <QuestionField
            key={question.id}
            question={question}
            draft={draftFor(drafts, question.id)}
            disabled={isPending}
            onChange={(draft) => setDrafts((current) => ({ ...current, [question.id]: draft }))}
          />
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={isPending || answeredCount === 0}>
            {m.question_submit()}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={isPending} action={() => respond({})}>
            {single ? m.question_skip() : m.question_skip_all()}
          </Button>
          {!single && <p className="text-xs text-muted-foreground">{m.question_blank_skipped()}</p>}
        </div>
      </form>
      {error && <FieldError>{error}</FieldError>}
    </section>
  )
}

function QuestionField({
  question,
  draft,
  disabled,
  onChange,
}: {
  question: Question
  draft: Draft
  disabled: boolean
  onChange: (draft: Draft) => void
}) {
  const textId = useId()
  const onText = (text: string) => onChange({ picked: question.multiSelect ? draft.picked : [], text })
  const onPick = (label: string) => onChange({ picked: [label], text: "" })
  const onToggle = (label: string, checked: boolean) =>
    onChange({
      ...draft,
      picked: checked ? [...draft.picked, label] : draft.picked.filter((picked) => picked !== label),
    })

  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label" className="flex flex-wrap items-center gap-2">
        {question.header !== "" && <Badge variant="outline">{question.header}</Badge>}
        <span>{question.question}</span>
      </FieldLegend>
      {question.options.length > 0 &&
        (question.multiSelect ? (
          <div className="grid gap-1.5">
            {question.options.map((option) => (
              <FieldLabel key={option.label}>
                <Field orientation="horizontal">
                  <Checkbox
                    checked={draft.picked.includes(option.label)}
                    onCheckedChange={(checked) => onToggle(option.label, checked)}
                    disabled={disabled}
                  />
                  <OptionText label={option.label} description={option.description} />
                </Field>
              </FieldLabel>
            ))}
          </div>
        ) : (
          <RadioGroup
            value={draft.picked[0] ?? null}
            onValueChange={(value) => onPick(value as string)}
            disabled={disabled}
            className="gap-1.5"
          >
            {question.options.map((option) => (
              <FieldLabel key={option.label}>
                <Field orientation="horizontal">
                  <RadioGroupItem value={option.label} />
                  <OptionText label={option.label} description={option.description} />
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>
        ))}
      {question.allowsText && (
        <Field>
          <label htmlFor={textId} className={question.options.length > 0 ? "text-xs text-muted-foreground" : "sr-only"}>
            {question.options.length > 0 ? m.question_other() : question.question}
          </label>
          <Input
            id={textId}
            type={question.secret ? "password" : "text"}
            value={draft.text}
            onChange={(event) => onText(event.target.value)}
            disabled={disabled}
            autoComplete="off"
            spellCheck={!question.secret}
          />
        </Field>
      )}
    </FieldSet>
  )
}

function OptionText({ label, description }: { label: string; description: string }) {
  return (
    <FieldContent>
      <FieldTitle>{label}</FieldTitle>
      {description !== "" && <FieldDescription className="text-xs">{description}</FieldDescription>}
    </FieldContent>
  )
}
