import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { formatForDisplay } from "@tanstack/react-hotkeys"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  lazy,
  startTransition,
  Suspense,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useTransition,
} from "react"
import { cn } from "../lib/utils.ts"
import type { AgentCommand } from "../../shared/agent.ts"
import type { RpcRequest } from "../../shared/contract.ts"
import { isThreadBusy, type Project, type Thread, toCheckoutTarget } from "../../shared/domain.ts"
import { providerInfo } from "../../shared/providers.ts"
import { mentionableThreads } from "../../shared/threadMention.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { promptWithComments } from "../lib/lineComments.ts"
import {
  callPromise,
  commandsAtom,
  completionKey,
  currentBranchAtom,
  filesAtom,
  noFilesAtom,
  projectsAtom,
  threadCommands,
} from "../lib/rpc.ts"
import { askSidechat, sidechatCommand, sidechatQuestion } from "../lib/sidechat.ts"
import { useIsChat } from "../lib/useIsChat.ts"
import { m } from "../paraglide/messages.js"
import { type Draft, emptyDraft, useDrafts } from "../stores/drafts.ts"
import { useMessages } from "../stores/messages.ts"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import {
  ComposerActions,
  ComposerAttachButton,
  ComposerBar,
  Composer as ComposerRoot,
  ComposerSend,
  ComposerToolbar,
} from "./assistant-ui/elements/composer.tsx"
import { PendingAttachment } from "./AttachmentView.tsx"
import { ThreadPicker, WorkspacePicker } from "./ComposerControls.tsx"
import { ComposerStatusLine } from "./ComposerStatusLine.tsx"
import type { ComposerInputHandle } from "./ComposerInput.tsx"
import { ContextRing } from "./ContextRing.tsx"
import { PendingLineComment } from "./LineComment.tsx"
import { ActivityIndicator } from "./ActivityIndicator.tsx"
import { QueueBar } from "./QueueBar.tsx"
import { ScheduleButton, ScheduledBar } from "./ScheduledMessages.tsx"
import { FieldError } from "./ui/field.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"
import { useModifierHeld } from "../lib/useModifierHeld.ts"
import { SendGlyph, type SendGlyphMode } from "./icons/SendGlyph.tsx"
import { UploadIcon } from "@hinacode/icons"
import { ChordKeys } from "./ChordKeys.tsx"
import { useKeymap } from "../keybindings/useKeybindings.ts"

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => resolve(String(reader.result)))
    reader.addEventListener("error", () => reject(reader.error))
    reader.readAsDataURL(file)
  })

const carriesFiles = (event: ReactDragEvent) => event.dataTransfer.types.includes("Files")

type StageSource = RpcRequest<"attachments.stage">["source"]

type Delivery = "queue" | "steer"

const STEER_CHORD = "Mod+Enter"

const composerInputModule = import("./ComposerInput.tsx")
const ComposerInput = lazy(() => composerInputModule.then((module) => ({ default: module.ComposerInput })))

const deliveryOf = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey ? "steer" : "queue")

const deliver = (
  threadId: string,
  prompt: string,
  sent: Draft,
  { busy, unstarted, delivery }: { busy: boolean; unstarted: boolean; delivery: Delivery },
) => {
  if (busy) {
    return callPromise(delivery === "queue" ? "threads.queue" : "threads.steer", {
      threadId,
      text: prompt,
      attachments: sent.attachments,
    })
  }
  const workspace =
    unstarted && sent.workspace
      ? { mode: sent.workspace.mode, target: toCheckoutTarget(sent.workspace.ref) }
      : undefined
  return callPromise("threads.send", { threadId, prompt, attachments: sent.attachments, workspace })
}

const sourceOf = async (file: File): Promise<StageSource> => {
  const path = window.hinacode.pathForFile(file)
  if (path !== "") return { path }
  return { dataUrl: await readAsDataUrl(file), name: file.name || "pasted.png" }
}

export function Composer({ thread, children }: { thread: Thread; children?: ReactNode }) {
  const { text, attachments, workspace, comments } = useDrafts((state) => state.byThreadId[thread.id] ?? emptyDraft)
  const isSidechat = thread.sideOf !== null
  const unstarted = useMessages((state) => {
    const history = state.byThread[thread.id]
    return history?.status === "ready" && history.messages.length === 0 && thread.worktreeId === null && !isSidechat
  })
  const isChat = useIsChat(thread.projectId)
  const [error, setError] = useState<string | null>(null)
  const [isSending, startSending] = useTransition()
  const [isStaging, startStaging] = useTransition()
  const inputRef = useRef<ComposerInputHandle>(null)
  const key = completionKey(thread)
  const commandsResult = useAtomValue(commandsAtom(key))
  const agentCommands = threadCommands(
    AsyncResult.getOrElse(commandsResult, (): ReadonlyArray<AgentCommand> => []),
    thread,
  )
  const commands = isSidechat ? agentCommands : [sidechatCommand(), ...agentCommands]
  const commandsError = AsyncResult.isFailure(commandsResult)
    ? m.composer_commands_failed({ message: errorMessage(Cause.squash(commandsResult.cause)) })
    : null
  const filesSource = text.includes("@") ? filesAtom(key) : noFilesAtom
  const files = AsyncResult.getOrElse(useAtomValue(filesSource), (): ReadonlyArray<string> => [])
  const refreshFiles = useAtomRefresh(filesSource)
  const threadsById = useThreads((state) => state.byId)
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => [])
  const mentionable = mentionableThreads(thread, Object.values(threadsById), projects)
  const refreshCommands = useAtomRefresh(commandsAtom(key))
  const refreshRootBranch = useAtomRefresh(currentBranchAtom(thread.projectId))
  const busy = isThreadBusy(thread.status)
  const hasDraft = text.trim() !== "" || attachments.length > 0 || comments.length > 0
  const canSend = hasDraft && !isSending && !isStaging
  const steers = providerInfo[thread.provider].steersRunningTurn
  const placeholder =
    !steers && busy
      ? m.thread_composer_queue_only_placeholder()
      : thread.status === "awaiting_approval"
        ? m.thread_composer_approval_placeholder({ steer: formatForDisplay(STEER_CHORD) })
        : busy
          ? m.thread_composer_queue_placeholder({ steer: formatForDisplay(STEER_CHORD) })
          : isSidechat
            ? m.sidechat_placeholder()
            : m.thread_composer_placeholder()
  const modifierHeld = useModifierHeld()
  const clickDelivery: Delivery = modifierHeld && steers ? "steer" : "queue"
  const sendMode: SendGlyphMode = !(busy || isSending) ? "send" : hasDraft ? clickDelivery : "stop"

  const send = (delivery: Delivery) => {
    if (!canSend) return
    const sent = useDrafts.getState().take(thread.id)
    const prompt = promptWithComments(sent.text, sent.comments)
    const question = isSidechat ? null : sidechatQuestion(prompt)
    setError(null)
    startSending(async () => {
      const delivered =
        question === null
          ? deliver(thread.id, prompt, sent, { busy, unstarted, delivery })
          : askSidechat(thread.id, question, sent.attachments)
      await delivered.catch((cause: unknown) => {
        useDrafts.getState().restore(thread.id, sent)
        setError(errorMessage(cause))
      })
      if (sent.workspace?.mode === "local") refreshRootBranch()
    })
  }

  const stage = (sources: ReadonlyArray<Promise<StageSource> | StageSource>) => {
    if (sources.length === 0) return
    setError(null)
    startStaging(async () => {
      const results = await Promise.allSettled(
        sources.map(async (source) => callPromise("attachments.stage", { threadId: thread.id, source: await source })),
      )
      const staged = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      useDrafts.getState().addAttachments(thread.id, staged)
      const failed = results.find((result) => result.status === "rejected")
      if (failed) setError(errorMessage(failed.reason))
    })
  }

  const pickFiles = async () => {
    try {
      const paths = await callPromise("dialog.pickFiles", undefined)
      stage(paths.map((path) => ({ path })))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const onPaste = (event: ClipboardEvent) => {
    const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"))
    if (images.length === 0) return
    event.preventDefault()
    stage(images.map(sourceOf))
  }

  const [dragging, setDragging] = useState(false)
  const dropZone = {
    onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      if (!dragging) setDragging(true)
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
    },
    onDropCapture: (event: ReactDragEvent<HTMLDivElement>) => {
      setDragging(false)
      const dropped = [...event.dataTransfer.files]
      if (dropped.length === 0) return
      event.preventDefault()
      stage(dropped.map(sourceOf))
    },
  }

  const canWarm = !busy && !isSidechat && !(unstarted && workspace !== null)
  const changeText = (next: string) => {
    if (text === "" && next !== "" && canWarm)
      callPromise("threads.warm", { threadId: thread.id }).catch(() => undefined)
    useDrafts.getState().setText(thread.id, next)
  }

  const stop = () => {
    callPromise("threads.interrupt", { threadId: thread.id }).catch((cause: unknown) => setError(errorMessage(cause)))
  }

  const focusWhenReady = useComposerRequests(inputRef, isSidechat, () => {
    if (busy || isSending) stop()
  })

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    send(clickDelivery)
  }

  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) {
      refreshFiles()
      refreshCommands()
    }
    wasBusy.current = busy
  }, [busy, refreshFiles, refreshCommands])

  return (
    <div className="flex min-h-0 flex-col px-3 pb-3">
      <ComposerNotices>{children}</ComposerNotices>
      <form onSubmit={onSubmit} className="flex max-h-[60cqh] min-h-0 shrink-0 flex-col">
        <ComposerRoot className="mx-auto flex min-h-0 max-w-3xl flex-col [--composer-edge:color-mix(in_oklab,var(--border)_60%,transparent)] has-[[data-slot=composer-bar]:focus-within]:[--composer-edge:var(--ring)]">
          <ActivityIndicator thread={thread}>
            <QueueBar thread={thread} onEdit={() => inputRef.current?.focus()} onError={setError} />
            <ScheduledBar thread={thread} onEdit={() => inputRef.current?.focus()} onError={setError} />
          </ActivityIndicator>
          <ComposerBar
            {...dropZone}
            dragActive={dragging}
            className="composer-edge min-h-0 has-[[role=listbox]]:z-20 data-drag-active:[--composer-edge:var(--ring)]"
          >
            {dragging && <DropHint />}
            {comments.length > 0 && (
              <ul
                aria-label={m.comment_pending_label()}
                className="flex max-h-20 min-h-0 flex-wrap gap-2 overflow-y-auto px-1 pt-1.5"
              >
                {comments.map((comment) => (
                  <li key={comment.id}>
                    <PendingLineComment
                      comment={comment}
                      onRemove={() => useDrafts.getState().removeComment(thread.id, comment.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {attachments.length > 0 && (
              <ul
                aria-label={m.attachment_pending_label()}
                className="flex max-h-20 min-h-0 flex-wrap gap-2 overflow-y-auto px-1 pt-1.5"
              >
                {attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <PendingAttachment
                      attachment={attachment}
                      onRemove={() => useDrafts.getState().removeAttachment(thread.id, attachment.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
            <Suspense fallback={<DraftPreview text={text} placeholder={placeholder} />}>
              <ComposerInput
                ref={inputRef}
                aria-label={isSidechat ? m.panel_tab_sidechat() : m.thread_composer_label()}
                placeholder={placeholder}
                value={text}
                onValueChange={changeText}
                commands={commands}
                files={files}
                onMentionStart={refreshFiles}
                threads={mentionable}
                projectId={thread.projectId}
                onEnter={(event) => send(steers ? deliveryOf(event) : "queue")}
                onPaste={onPaste}
                focusOnMount={focusWhenReady}
              />
            </Suspense>
            <ComposerToolbar className="relative shrink-0 gap-2">
              <ComposerActions className="min-w-0 flex-1">
                <AttachButton onClick={() => startStaging(pickFiles)} disabled={isStaging} />
                <ThreadPicker thread={thread} canSwitchAgent={!busy && !isSidechat} onError={setError} />
              </ComposerActions>
              <ContextRing threadId={thread.id} provider={thread.provider} />
              {!isSidechat && (
                <ScheduleButton thread={thread} unstarted={unstarted} disabled={!canSend} onError={setError} />
              )}
              {(sendMode === "queue" || sendMode === "steer") && <StopButton onStop={stop} />}
              <SendButton mode={sendMode} canSend={canSend} onStop={stop} />
            </ComposerToolbar>
          </ComposerBar>
        </ComposerRoot>
        {error !== null ? (
          <FieldError className="mx-auto w-full max-w-3xl bg-background px-3 pt-1">{error}</FieldError>
        ) : (
          commandsError !== null && <CommandsError message={commandsError} />
        )}
        {unstarted ? (
          !isChat && <WorkspacePicker thread={thread} workspace={workspace} />
        ) : (
          <ComposerStatusLine thread={thread} />
        )}
      </form>
    </div>
  )
}

export function ComposerNotices({ children }: { children?: ReactNode }) {
  return <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col bg-background empty:hidden">{children}</div>
}

function useComposerRequests(
  inputRef: RefObject<ComposerInputHandle | null>,
  isSidechat: boolean,
  onInterrupt: () => void,
) {
  const interrupt = useEffectEvent(onInterrupt)
  const [focusWhenReady, setFocusWhenReady] = useState(false)
  const focus = useEffectEvent(() => {
    if (inputRef.current) inputRef.current.focus()
    else setFocusWhenReady(true)
  })

  useEffect(() => {
    if (isSidechat) return
    return useUi.subscribe((state, previous) => {
      if (state.composerFocusRequest !== previous.composerFocusRequest) focus()
      if (state.interruptRequest !== previous.interruptRequest) interrupt()
    })
  }, [isSidechat])

  const sidechatFocusRequested = useUi((state) => isSidechat && state.viewFocusRequest === "sidechat")
  useEffect(() => {
    if (!sidechatFocusRequested) return
    useUi.getState().clearViewFocusRequest()
    // FIXME: Base UI Dialog places its initial focus a frame late, which would take focus back
    requestAnimationFrame(() => focus())
  }, [sidechatFocusRequested])

  return focusWhenReady
}

function DraftPreview({ text, placeholder }: { text: string; placeholder: string }) {
  return (
    <p
      className={cn(
        "max-h-60 min-h-[calc(1lh+1rem)] overflow-hidden px-2.5 py-2 text-sm whitespace-pre-wrap",
        text === "" && "text-muted-foreground",
      )}
    >
      {text === "" ? placeholder : text}
    </p>
  )
}

function AttachButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerAttachButton
            onClick={onClick}
            disabled={disabled}
            aria-label={m.attachment_add()}
            className="shrink-0"
          />
        }
      />
      <TooltipContent>{m.attachment_add_hint()}</TooltipContent>
    </Tooltip>
  )
}

function DropHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-[inherit] bg-background/90 text-sm transition-opacity duration-150 ease-out motion-reduce:transition-none starting:opacity-0">
      <UploadIcon aria-hidden className="size-4 text-muted-foreground" />
      {m.attachment_drop_hint()}
    </div>
  )
}

function StopTooltip({ children }: { children: ReactElement }) {
  const chord = useKeymap()["turn.interrupt"]
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>
        {m.thread_composer_stop()}
        {chord && <ChordKeys chord={chord} />}
      </TooltipContent>
    </Tooltip>
  )
}

function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <StopTooltip>
      <button
        type="button"
        onClick={onStop}
        aria-label={m.thread_composer_stop()}
        className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground/6 text-muted-foreground inset-ring inset-ring-border transition-[background-color,color,scale,opacity] duration-150 ease-out hover:bg-foreground/10 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none dark:bg-foreground/9 starting:scale-75 starting:opacity-0 forced-colors:border"
      >
        <SendGlyph mode="stop" className="size-4" />
      </button>
    </StopTooltip>
  )
}

function SendButton({ mode, canSend, onStop }: { mode: SendGlyphMode; canSend: boolean; onStop: () => void }) {
  const button = (label: string) => (
    <ComposerSend
      type={mode === "stop" ? "button" : "submit"}
      onClick={mode === "stop" ? onStop : undefined}
      mode={mode}
      idle={!canSend}
      disabled={mode !== "stop" && !canSend}
      aria-label={label}
    />
  )
  if (mode === "stop") return <StopTooltip>{button(m.thread_composer_stop())}</StopTooltip>
  const label = {
    send: m.thread_composer_send(),
    queue: m.thread_composer_queue(),
    steer: m.thread_composer_steer(),
  }[mode]
  return (
    <Tooltip>
      <TooltipTrigger render={button(label)} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function CommandsError({ message }: { message: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <FieldError className="mx-auto flex w-full max-w-3xl items-start gap-2 bg-background px-3 pt-1 text-xs">
      <span className={cn("min-w-0 flex-1 select-text", expanded ? "whitespace-pre-wrap" : "truncate")}>{message}</span>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => startTransition(() => setExpanded(!expanded))}
        className="shrink-0 rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {expanded ? m.composer_commands_failed_hide() : m.composer_commands_failed_details()}
      </button>
    </FieldError>
  )
}
