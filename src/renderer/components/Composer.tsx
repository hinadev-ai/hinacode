import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { formatForDisplay } from "@tanstack/react-hotkeys"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  type DragEvent as ReactDragEvent,
  type FormEvent,
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
import { ChordKeys } from "./ChordKeys.tsx"
import { ThreadPicker, WorkspacePicker } from "./ComposerControls.tsx"
import { ComposerStatusLine } from "./ComposerStatusLine.tsx"
import type { ComposerInputHandle } from "./ComposerInput.tsx"
import { ContextRing } from "./ContextRing.tsx"
import { PendingLineComment } from "./LineComment.tsx"
import { ActivityIndicator } from "./ActivityIndicator.tsx"
import { QueueBar } from "./QueueBar.tsx"
import { Button } from "./ui/button.tsx"
import { FieldError } from "./ui/field.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => resolve(String(reader.result)))
    reader.addEventListener("error", () => reject(reader.error))
    reader.readAsDataURL(file)
  })

const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
  if (event.dataTransfer.types.includes("Files")) event.preventDefault()
}

type StageSource = RpcRequest<"attachments.stage">["source"]

type Delivery = "queue" | "steer"

const STEER_CHORD = "Mod+Enter"

const ComposerInput = lazy(() => import("./ComposerInput.tsx").then((module) => ({ default: module.ComposerInput })))

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
  const placeholder = busy
    ? m.thread_composer_queue_placeholder({ steer: formatForDisplay(STEER_CHORD) })
    : isSidechat
      ? m.sidechat_placeholder()
      : m.thread_composer_placeholder()

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

  const onDrop = (event: DragEvent) => {
    const dropped = [...(event.dataTransfer?.files ?? [])]
    if (dropped.length === 0) return
    event.preventDefault()
    stage(dropped.map(sourceOf))
  }

  const stop = () => {
    callPromise("threads.interrupt", { threadId: thread.id }).catch((cause: unknown) => setError(errorMessage(cause)))
  }

  useComposerRequests(inputRef, isSidechat, () => {
    if (busy || isSending) stop()
  })

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    send("queue")
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
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col bg-background empty:hidden">{children}</div>
      <form onSubmit={onSubmit} className="flex max-h-[60cqh] min-h-0 shrink-0 flex-col">
        <ComposerRoot className="mx-auto flex min-h-0 max-w-3xl flex-col [--composer-edge:color-mix(in_oklab,var(--border)_60%,transparent)] has-[[data-slot=composer-bar]:focus-within]:[--composer-edge:var(--ring)]">
          <ActivityIndicator thread={thread}>
            <QueueBar thread={thread} onEdit={() => inputRef.current?.focus()} onError={setError} />
          </ActivityIndicator>
          <ComposerBar className="min-h-0 border-(color:--composer-edge) has-[[role=listbox]]:z-20">
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
                onValueChange={(next) => useDrafts.getState().setText(thread.id, next)}
                commands={commands}
                files={files}
                threads={mentionable}
                projectId={thread.projectId}
                onEnter={(event) => send(deliveryOf(event))}
                onPaste={onPaste}
                onDragOver={onDragOver}
                onDrop={onDrop}
              />
            </Suspense>
            <ComposerToolbar className="relative shrink-0 gap-2">
              <ComposerActions className="min-w-0 flex-1">
                <AttachButton onClick={pickFiles} disabled={isStaging} />
                <ThreadPicker thread={thread} canSwitchAgent={!busy && !isSidechat} onError={setError} />
              </ComposerActions>
              <ContextRing threadId={thread.id} provider={thread.provider} />
              <SteerButton busy={busy} hasDraft={hasDraft} canSend={canSend} onSteer={() => send("steer")} />
              <SendButton busy={busy || isSending} hasDraft={hasDraft} canSend={canSend} onStop={stop} />
            </ComposerToolbar>
          </ComposerBar>
        </ComposerRoot>
        {error !== null ? (
          <FieldError className="mx-auto mt-1 w-full max-w-3xl px-3">{error}</FieldError>
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

function useComposerRequests(
  inputRef: RefObject<ComposerInputHandle | null>,
  isSidechat: boolean,
  onInterrupt: () => void,
) {
  const interrupt = useEffectEvent(onInterrupt)

  useEffect(() => {
    if (isSidechat) return
    return useUi.subscribe((state, previous) => {
      if (state.composerFocusRequest !== previous.composerFocusRequest) inputRef.current?.focus()
      if (state.interruptRequest !== previous.interruptRequest) interrupt()
    })
  }, [inputRef, isSidechat])

  const sidechatFocusRequested = useUi((state) => isSidechat && state.viewFocusRequest === "sidechat")
  useEffect(() => {
    if (!sidechatFocusRequested) return
    useUi.getState().clearViewFocusRequest()
    // FIXME: Base UI Dialog places its initial focus a frame late, which would take focus back
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [inputRef, sidechatFocusRequested])
}

function DraftPreview({ text, placeholder }: { text: string; placeholder: string }) {
  return (
    <p
      className={cn(
        "max-h-60 min-h-[calc(1lh+1rem)] overflow-hidden px-2.5 py-2 text-base whitespace-pre-wrap md:text-sm",
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

function SteerButton({
  busy,
  hasDraft,
  canSend,
  onSteer,
}: {
  busy: boolean
  hasDraft: boolean
  canSend: boolean
  onSteer: () => void
}) {
  if (!busy || !hasDraft) return null
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size="sm" disabled={!canSend} onClick={onSteer} />}>
        {m.thread_composer_steer()}
      </TooltipTrigger>
      <TooltipContent>
        {m.thread_composer_steer_hint()}
        <ChordKeys chord={STEER_CHORD} />
      </TooltipContent>
    </Tooltip>
  )
}

function SendButton({
  busy,
  hasDraft,
  canSend,
  onStop,
}: {
  busy: boolean
  hasDraft: boolean
  canSend: boolean
  onStop: () => void
}) {
  const stopping = busy && !hasDraft
  const label = stopping ? m.thread_composer_stop() : busy ? m.thread_composer_queue() : m.thread_composer_send()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerSend
            type={stopping ? "button" : "submit"}
            onClick={stopping ? onStop : undefined}
            streaming={stopping}
            idle={!canSend}
            disabled={!stopping && !canSend}
            aria-label={label}
          />
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function CommandsError({ message }: { message: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <FieldError className="mx-auto mt-1 flex w-full max-w-3xl items-start gap-2 px-3 text-xs">
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
