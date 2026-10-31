import { startTransition, useEffect, useRef, useState, type ActionDispatch, type KeyboardEvent } from "react"
import { fill } from "../fill.ts"
import {
  ArrowUpIcon,
  CheckCircleFillIcon,
  CheckIcon,
  CloseIcon,
  FileCodeIcon,
  PencilIcon,
  PlugIcon,
  PulseIcon,
  QuestionIcon,
  SearchIcon,
  ShieldIcon,
  SpinnerIcon,
  SteerIcon,
  TerminalIcon,
} from "../icons.ts"
import type { DemoCopy } from "./copy.ts"
import { isBlocked, isWorking, type Action, type Decision, type Item, type Thread, type ToolKind } from "./engine.ts"
import { buttonStyles, providerName, ProviderMark, StreamText } from "./ui.tsx"

type Props = { thread: Thread; copy: DemoCopy; locale: string; dispatch: ActionDispatch<[Action]> }

export function Transcript({ thread, copy, locale, dispatch }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const node = scroller.current
    const content = node?.firstElementChild
    if (!node || !content) return
    const observer = new ResizeObserver(() => {
      if (pinned.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const node = event.currentTarget
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 motion-safe:scroll-smooth"
    >
      <ol className="mx-auto flex max-w-[42rem] flex-col gap-3">
        {thread.items.map((item) => (
          <li key={item.id} className="item-enter">
            <ItemView item={item} {...{ thread, copy, locale, dispatch }} />
          </li>
        ))}
      </ol>
    </div>
  )
}

function ItemView({ item, thread, copy, locale, dispatch }: Props & { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ms-auto w-fit max-w-[85%] rounded-xl bg-muted px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink">
          {item.steered && (
            <span className="mb-1 flex items-center gap-1 text-[11px] font-medium text-ink-soft">
              <SteerIcon aria-hidden className="size-3" />
              {copy.site_demo_steered}
            </span>
          )}
          {item.text}
        </div>
      )
    case "assistant":
      return (
        <p className="text-[13.5px] leading-relaxed text-pretty text-ink">
          <StreamText text={item.text} animate={item.animate} locale={locale} />
        </p>
      )
    case "tool":
      return <ToolRow item={item} copy={copy} />
    case "approval":
      return item.decision ? (
        <div>
          <Resolved
            icon={item.decision === "deny" ? CloseIcon : CheckIcon}
            label={
              { allow: copy.approval_allow, session: copy.approval_allow_session, deny: copy.approval_deny }[
                item.decision
              ]
            }
            detail={item.command}
            mono
          />
          {item.note && <p className="ms-5.5 mt-1 text-xs text-ink">{item.note}</p>}
        </div>
      ) : (
        <ApprovalCard key={item.id} item={item} thread={thread} copy={copy} dispatch={dispatch} />
      )
    case "question":
      return item.answer ? (
        <Resolved icon={QuestionIcon} label={item.question} detail={item.answer} />
      ) : (
        <QuestionCard key={item.id} item={item} thread={thread} copy={copy} dispatch={dispatch} />
      )
    case "event":
      return (
        <p
          className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed ${
            item.tone === "attention" ? "bg-attention-soft text-attention" : "bg-teal-soft text-teal"
          }`}
        >
          {item.tone === "attention" ? (
            <PulseIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          ) : (
            <CheckCircleFillIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          )}
          {item.text}
        </p>
      )
    case "worked":
      return (
        <p className="flex items-center gap-3 py-1 text-[11px] text-ink-soft">
          <span aria-hidden className="h-px flex-1 bg-line" />
          {fill(copy.message_worked_for, { duration: item.duration })}
          <span aria-hidden className="h-px flex-1 bg-line" />
        </p>
      )
  }
}

const toolIcons = { read: FileCodeIcon, search: SearchIcon, edit: PencilIcon, run: TerminalIcon, mcp: PlugIcon }

function toolLabel(copy: DemoCopy, tool: ToolKind) {
  return {
    read: copy.site_demo_tool_read,
    search: copy.site_demo_tool_search,
    edit: copy.site_demo_tool_edit,
    run: copy.site_demo_tool_run,
    mcp: "hinacode",
  }[tool]
}

function ToolRow({ item, copy }: { item: Extract<Item, { kind: "tool" }>; copy: DemoCopy }) {
  const Icon = toolIcons[item.tool]
  return (
    <div className="text-xs text-ink-soft">
      <div className="flex min-w-0 items-center gap-2">
        {item.running ? (
          <SpinnerIcon
            aria-hidden
            className="size-3.5 shrink-0 animate-spin text-ink-soft [--sun:var(--color-coral)]"
          />
        ) : (
          <Icon aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="shrink-0 font-medium">{toolLabel(copy, item.tool)}</span>
        <span className="min-w-0 truncate font-mono text-[11.5px] text-ink">{item.target}</span>
        {item.added !== undefined && (
          <span className="font-mono text-[11px] text-teal tabular-nums">+{item.added}</span>
        )}
        {item.removed !== undefined && (
          <span className="font-mono text-[11px] text-danger tabular-nums">−{item.removed}</span>
        )}
      </div>
      {item.diff && (
        <pre className="ms-5.5 mt-1.5 overflow-x-auto rounded-lg bg-surface py-1.5 font-mono text-[11px] leading-5 shadow-[0_0_0_1px_var(--color-line)]">
          {item.diff.map((line) => (
            <span
              key={line.sign + line.code}
              className={`block px-2.5 ${line.sign === "+" ? "bg-teal-soft text-ink" : "bg-danger-soft text-ink"}`}
            >
              <span aria-hidden className={line.sign === "+" ? "text-teal" : "text-danger"}>
                {line.sign === "+" ? "+ " : "− "}
              </span>
              {line.code}
            </span>
          ))}
        </pre>
      )}
      {item.output && !item.running && <p className="ms-5.5 mt-1 font-mono text-[11px]">{item.output}</p>}
    </div>
  )
}

function Resolved({
  icon: Icon,
  label,
  detail,
  mono = false,
}: {
  icon: typeof CheckIcon
  label: string
  detail: string
  mono?: boolean
}) {
  return (
    <p className="flex min-w-0 items-center gap-2 text-xs text-ink-soft">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium text-ink">{label}</span>
      <span className={`min-w-0 truncate ${mono ? "font-mono text-[11.5px]" : ""}`}>{detail}</span>
    </p>
  )
}

function ApprovalCard({
  item,
  thread,
  copy,
  dispatch,
}: Omit<Props, "locale"> & { item: Extract<Item, { kind: "approval" }> }) {
  const [note, setNote] = useState("")
  const decide = (decision: Decision) =>
    startTransition(() => dispatch({ type: "decide", threadId: thread.id, itemId: item.id, decision, note }))
  return (
    <div className="rounded-xl bg-attention-soft p-3.5 shadow-[0_0_0_1px_var(--color-attention-line)]">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
        <ShieldIcon aria-hidden className="size-4 text-attention" />
        {fill(copy.approval_title, { provider: providerName(copy, thread.provider) })}
      </p>
      <p className="mt-1 text-xs text-ink-soft">{item.reason}</p>
      <pre className="mt-2.5 overflow-x-auto rounded-lg bg-paper px-3 py-2 font-mono text-xs text-ink shadow-[0_0_0_1px_var(--color-line)]">
        <span aria-hidden className="text-ink-soft select-none">
          ${" "}
        </span>
        {item.command}
      </pre>
      <input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) decide("deny")
        }}
        aria-label={copy.approval_note_label}
        placeholder={copy.approval_note_placeholder}
        className="mt-2.5 h-8 w-full rounded-lg bg-paper px-3 text-xs text-ink shadow-[0_0_0_1px_var(--color-line)] outline-none placeholder:text-ink-soft focus-visible:shadow-[0_0_0_2px_var(--color-teal)]"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={buttonStyles.primary} onClick={() => decide("allow")}>
          {copy.approval_allow}
        </button>
        <button type="button" className={buttonStyles.secondary} onClick={() => decide("session")}>
          {copy.approval_allow_session}
        </button>
        <button type="button" className={buttonStyles.ghost} onClick={() => decide("deny")}>
          {copy.approval_deny}
        </button>
      </div>
    </div>
  )
}

function QuestionCard({
  item,
  thread,
  copy,
  dispatch,
}: Omit<Props, "locale"> & { item: Extract<Item, { kind: "question" }> }) {
  const [choice, setChoice] = useState("")
  const [other, setOther] = useState("")
  const answer = other.trim() || choice
  return (
    <form
      className="rounded-xl bg-surface p-3.5 shadow-[0_0_0_1px_var(--color-line-strong)]"
      onSubmit={(event) => {
        event.preventDefault()
        if (answer) startTransition(() => dispatch({ type: "answer", threadId: thread.id, itemId: item.id, answer }))
      }}
    >
      <fieldset>
        <legend className="flex items-center gap-2 text-xs font-medium text-ink-soft">
          <QuestionIcon aria-hidden className="size-3.5 text-attention" />
          {fill(copy.question_title, { provider: providerName(copy, thread.provider) })}
        </legend>
        <p className="mt-1.5 text-[13.5px] font-semibold text-ink">{item.question}</p>
        <div className="mt-2.5 grid gap-1.5">
          {item.options.map((option) => (
            <label
              key={option.label}
              className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 rounded-lg bg-paper px-3 py-2 shadow-[0_0_0_1px_var(--color-line)] transition-[box-shadow,background-color] duration-150 hover:bg-muted has-checked:shadow-[0_0_0_2px_var(--color-teal)]"
            >
              <input
                type="radio"
                name={`question-${item.id}`}
                value={option.label}
                checked={choice === option.label && !other}
                onChange={() => {
                  setChoice(option.label)
                  setOther("")
                }}
                className="row-span-2 mt-0.5 accent-teal"
              />
              <span className="text-[13px] font-medium text-ink">{option.label}</span>
              <span className="text-xs text-ink-soft">{option.hint}</span>
            </label>
          ))}
        </div>
        <input
          value={other}
          onChange={(event) => setOther(event.target.value)}
          aria-label={copy.question_other}
          placeholder={copy.question_other}
          className="mt-2 h-8 w-full rounded-lg bg-paper px-3 text-xs text-ink shadow-[0_0_0_1px_var(--color-line)] outline-none placeholder:text-ink-soft focus-visible:shadow-[0_0_0_2px_var(--color-teal)]"
        />
      </fieldset>
      <div className="mt-3 flex justify-end">
        <button type="submit" disabled={!answer} className={buttonStyles.primary}>
          {copy.question_submit}
        </button>
      </div>
    </form>
  )
}

export function Composer({ thread, copy, dispatch }: Omit<Props, "locale">) {
  const [text, setText] = useState("")
  const working = (isWorking(thread) && !thread.resting) || isBlocked(thread)

  const submit = (mode: "send" | "queue" | "steer") => {
    const value = text.trim()
    if (!value) return
    setText("")
    startTransition(() => dispatch({ type: "send", threadId: thread.id, text: value, mode }))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!working) submit("send")
    else submit(event.metaKey || event.ctrlKey ? "steer" : "queue")
  }

  return (
    <div className="px-4 pb-4">
      {thread.queue.length > 0 && (
        <div className="mx-auto mb-2 max-w-[42rem] rounded-lg bg-surface px-3 py-2 text-xs shadow-[0_0_0_1px_var(--color-line)]">
          <p className="font-medium text-ink-soft">{copy.queue_label}</p>
          <ul className="mt-1 space-y-0.5 text-ink">
            {thread.queue.map((queued, index) => (
              <li key={`${index}-${queued}`} className="truncate">
                {queued}
              </li>
            ))}
          </ul>
        </div>
      )}
      <form
        className="mx-auto max-w-[42rem] rounded-xl bg-paper px-3 pt-2.5 pb-2 shadow-[0_0_0_1px_var(--color-line-strong),0_1px_2px_oklch(0_0_0/0.04)] transition-shadow duration-150 focus-within:shadow-[0_0_0_2px_var(--color-teal)]"
        onSubmit={(event) => {
          event.preventDefault()
          submit(working ? "steer" : "send")
        }}
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          aria-label={working ? copy.site_demo_composer_running : copy.site_demo_composer_idle}
          placeholder={working ? copy.site_demo_composer_running : copy.site_demo_composer_idle}
          className="block w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-soft"
        />
        <div className="mt-1 flex items-center gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-soft">
            <ProviderMark provider={thread.provider} className="size-3.5" />
            <span className="truncate">{providerName(copy, thread.provider)}</span>
          </span>
          <span className="ms-auto flex items-center gap-1.5">
            {working ? (
              <>
                <button type="button" className={buttonStyles.secondary} onClick={() => submit("queue")}>
                  {copy.thread_composer_queue}
                </button>
                <button type="submit" className={buttonStyles.primary}>
                  <SteerIcon aria-hidden className="size-3.5" />
                  {copy.thread_composer_steer}
                </button>
              </>
            ) : (
              <button type="submit" aria-label={copy.thread_composer_send} className={buttonStyles.send}>
                <ArrowUpIcon aria-hidden className="size-4" />
              </button>
            )}
          </span>
        </div>
      </form>
    </div>
  )
}
