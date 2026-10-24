import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { formatForDisplay } from "@tanstack/react-hotkeys"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useTransition,
} from "react"
import type { AgentCommand } from "../../shared/agent.ts"
import type { RpcRequest } from "../../shared/contract.ts"
import { type Thread, toCheckoutTarget } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { promptWithComments } from "../lib/lineComments.ts"
import { callPromise, commandsAtom, completionKey, currentBranchAtom, filesAtom } from "../lib/rpc.ts"
import { useIsChat } from "../lib/useIsChat.ts"
import { m } from "../paraglide/messages.js"
import { type Draft, emptyDraft, useDrafts } from "../stores/drafts.ts"
import { useMessages } from "../stores/messages.ts"
import { selectProjectThreads, useThreads } from "../stores/threads.ts"
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
import { ModelPicker, ThreadOptions, WorkspacePicker } from "./ComposerControls.tsx"
import { ComposerInput } from "./ComposerInput.tsx"
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

const onDragOver = (event: DragEvent<HTMLTextAreaElement>) => {
  if (event.dataTransfer.types.includes("Files")) event.preventDefault()
}

type StageSource = RpcRequest<"attachments.stage">["source"]

/** While the agent works, a message either waits for the turn to complete or steers it now. */
type Delivery = "queue" | "steer"

const STEER_CHORD = "Mod+Enter"

/** Mod+Enter steers; plain Enter and the send button queue. */
const deliveryOf = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey ? "steer" : "queue")

/** A busy thread takes the message by `delivery`; an idle one starts a turn. Only the first message picks a workspace. */
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

/** Files from disk are copied by path; pasted images and other path-less files are sent as data URLs. */
const sourceOf = async (file: File): Promise<StageSource> => {
  const path = window.hinacode.pathForFile(file)
  if (path !== "") return { path }
  return { dataUrl: await readAsDataUrl(file), name: file.name || "pasted.png" }
}

export function Composer({ thread }: { thread: Thread }) {
  const { text, attachments, workspace, comments } = useDrafts((state) => state.byThreadId[thread.id] ?? emptyDraft)
  // Agent and workspace stay open to change until the first message.
  const unstarted = useMessages((state) => {
    const history = state.byThread[thread.id]
    return history?.status === "ready" && history.messages.length === 0 && thread.worktreeId === null
  })
  const isChat = useIsChat(thread.projectId)
  const [error, setError] = useState<string | null>(null)
  const [isSending, startSending] = useTransition()
  const [isStaging, startStaging] = useTransition()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const key = completionKey(thread)
  const commandsResult = useAtomValue(commandsAtom(key))
  const commands = AsyncResult.getOrElse(commandsResult, (): ReadonlyArray<AgentCommand> => []).filter(
    (command) => thread.userSkills || command.scope !== "user",
  )
  // A failed load looks exactly like "the agent has no commands" when swallowed, so it is shown instead.
  const commandsError = AsyncResult.isFailure(commandsResult)
    ? m.composer_commands_failed({ message: errorMessage(Cause.squash(commandsResult.cause)) })
    : null
  const files = AsyncResult.getOrElse(useAtomValue(filesAtom(key)), (): ReadonlyArray<string> => [])
  const refreshFiles = useAtomRefresh(filesAtom(key))
  const threadsById = useThreads((state) => state.byId)
  const otherThreads = selectProjectThreads(thread.projectId)({ byId: threadsById }).filter(
    (other) => other.id !== thread.id,
  )
  const refreshCommands = useAtomRefresh(commandsAtom(key))
  const refreshRootBranch = useAtomRefresh(currentBranchAtom(thread.projectId))
  const busy = thread.status === "running" || thread.status === "awaiting_approval"
  const hasDraft = text.trim() !== "" || attachments.length > 0 || comments.length > 0
  const canSend = hasDraft && !isSending && !isStaging

  const send = (delivery: Delivery) => {
    if (!canSend) return
    const sent = useDrafts.getState().take(thread.id)
    const prompt = promptWithComments(sent.text, sent.comments)
    setError(null)
    startSending(async () => {
      await deliver(thread.id, prompt, sent, { busy, unstarted, delivery }).catch((cause: unknown) => {
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

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"))
    if (images.length === 0) return
    event.preventDefault()
    stage(images.map(sourceOf))
  }

  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    stage([...event.dataTransfer.files].map(sourceOf))
  }

  const stop = () => {
    callPromise("threads.interrupt", { threadId: thread.id }).catch((cause: unknown) => setError(errorMessage(cause)))
  }

  const interruptIfBusy = useEffectEvent(() => {
    if (busy || isSending) stop()
  })

  useEffect(
    () =>
      useUi.subscribe((state, previous) => {
        if (state.composerFocusRequest !== previous.composerFocusRequest) textareaRef.current?.focus()
        if (state.interruptRequest !== previous.interruptRequest) interruptIfBusy()
      }),
    [],
  )

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    send("queue")
  }

  // A finished turn may have added files worth mentioning, and gives a failed command load another chance.
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) {
      refreshFiles()
      refreshCommands()
    }
    wasBusy.current = busy
  }, [busy, refreshFiles, refreshCommands])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing: Enter confirms an IME candidate (zh-TW, ja) and must not send.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    send(deliveryOf(event))
  }

  return (
    <form onSubmit={onSubmit} className="flex max-h-[60cqh] min-h-0 shrink-0 flex-col px-3 pb-3">
      <ComposerRoot className="mx-auto flex min-h-0 max-w-3xl flex-col">
        <div className="flex min-h-0 flex-col bg-background">
          <ActivityIndicator thread={thread}>
            <QueueBar thread={thread} onEdit={() => textareaRef.current?.focus()} onError={setError} />
          </ActivityIndicator>
        </div>
        <ComposerBar className="min-h-0 focus-within:border-ring">
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
          <ComposerInput
            ref={textareaRef}
            aria-label={m.thread_composer_label()}
            placeholder={
              busy
                ? m.thread_composer_queue_placeholder({ steer: formatForDisplay(STEER_CHORD) })
                : m.thread_composer_placeholder()
            }
            value={text}
            onValueChange={(next) => useDrafts.getState().setText(thread.id, next)}
            commands={commands}
            files={files}
            threads={otherThreads}
            projectId={thread.projectId}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onDragOver={onDragOver}
            onDrop={onDrop}
            rows={2}
            className="min-h-[calc(1lh+1rem)]"
          />
          <ComposerToolbar className="shrink-0 gap-2">
            <ComposerActions className="min-w-0 flex-1">
              <AttachButton onClick={pickFiles} disabled={isStaging} />
              <ModelPicker thread={thread} canSwitchAgent={unstarted} onError={setError} />
              <ThreadOptions thread={thread} onError={setError} />
            </ComposerActions>
            <ContextRing threadId={thread.id} />
            <SteerButton busy={busy} hasDraft={hasDraft} canSend={canSend} onSteer={() => send("steer")} />
            <SendButton busy={busy || isSending} hasDraft={hasDraft} canSend={canSend} onStop={stop} />
          </ComposerToolbar>
        </ComposerBar>
      </ComposerRoot>
      {unstarted && !isChat && <WorkspacePicker thread={thread} workspace={workspace} onError={setError} />}
      {(error ?? commandsError) && <FieldError className="mx-auto mt-1 max-w-3xl">{error ?? commandsError}</FieldError>}
    </form>
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

/** Shown only while the agent runs and there is a draft to steer with. */
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

/** While the agent runs, an empty composer offers Stop and a draft offers Queue. */
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
