import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
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
import { RiAttachment2, RiSendPlaneLine, RiSteering2Line, RiStopFill } from "react-icons/ri"
import type { AgentCommand } from "../../shared/agent.ts"
import type { RpcRequest } from "../../shared/contract.ts"
import type { Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise, commandsAtom, completionKey, filesAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { emptyDraft, useDrafts } from "../stores/drafts.ts"
import { useMessages } from "../stores/messages.ts"
import { useUi } from "../stores/ui.ts"
import { PendingAttachment } from "./AttachmentView.tsx"
import {
  AccessPicker,
  AgentPicker,
  EffortPicker,
  FastModeToggle,
  ModelPicker,
  WorkspacePicker,
} from "./ComposerControls.tsx"
import { ComposerInput } from "./ComposerInput.tsx"
import { ContextRing } from "./ContextRing.tsx"
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

/** Files from disk are copied by path; pasted images and other path-less files are sent as data URLs. */
const sourceOf = async (file: File): Promise<StageSource> => {
  const path = window.kkcode.pathForFile(file)
  if (path !== "") return { path }
  return { dataUrl: await readAsDataUrl(file), name: file.name || "pasted.png" }
}

export function Composer({ thread }: { thread: Thread }) {
  const { text, attachments, worktree } = useDrafts((state) => state.byThreadId[thread.id] ?? emptyDraft)
  // Agent and workspace stay open to change until the first message.
  const unstarted = useMessages((state) => {
    const history = state.byThread[thread.id]
    return history?.status === "ready" && history.messages.length === 0 && thread.worktreeId === null
  })
  const [error, setError] = useState<string | null>(null)
  const [isSending, startSending] = useTransition()
  const [isStaging, startStaging] = useTransition()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const key = completionKey(thread)
  const commands = AsyncResult.getOrElse(useAtomValue(commandsAtom(key)), (): ReadonlyArray<AgentCommand> => [])
  const files = AsyncResult.getOrElse(useAtomValue(filesAtom(key)), (): ReadonlyArray<string> => [])
  const refreshFiles = useAtomRefresh(filesAtom(key))
  const busy = thread.status === "running" || thread.status === "awaiting_approval"
  const canSend = (text.trim() !== "" || attachments.length > 0) && !isSending && !isStaging

  const send = () => {
    if (!canSend) return
    const sent = useDrafts.getState().take(thread.id)
    const prompt = sent.text.trim()
    setError(null)
    startSending(async () => {
      try {
        await (busy
          ? callPromise("threads.steer", { threadId: thread.id, text: prompt, attachments: sent.attachments })
          : callPromise("threads.send", {
              threadId: thread.id,
              prompt,
              attachments: sent.attachments,
              worktree: unstarted ? (sent.worktree ?? undefined) : undefined,
            }))
      } catch (cause) {
        useDrafts.getState().restore(thread.id, sent)
        setError(errorMessage(cause))
      }
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
    if (busy) stop()
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
    send()
  }

  // A finished turn may have added files worth mentioning.
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) refreshFiles()
    wasBusy.current = busy
  }, [busy, refreshFiles])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing: Enter confirms an IME candidate (zh-TW, ja) and must not send.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    send()
  }

  return (
    <form onSubmit={onSubmit} className="flex max-h-3/5 min-h-0 shrink-0 flex-col px-3 pb-3">
      <div className="relative mx-auto flex min-h-0 w-full max-w-3xl flex-col gap-1 rounded-xl border border-input bg-input/30 p-2 focus-within:border-ring">
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
          placeholder={busy ? m.thread_composer_steer_placeholder() : m.thread_composer_placeholder()}
          value={text}
          onValueChange={(next) => useDrafts.getState().setText(thread.id, next)}
          commands={commands}
          files={files}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDragOver={onDragOver}
          onDrop={onDrop}
          rows={2}
          className="min-h-[calc(1lh+1rem)]"
        />
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <AttachButton onClick={pickFiles} disabled={isStaging} />
          {unstarted && <AgentPicker thread={thread} onError={setError} />}
          <ModelPicker thread={thread} onError={setError} />
          <EffortPicker thread={thread} onError={setError} />
          <FastModeToggle thread={thread} onError={setError} />
          <AccessPicker thread={thread} onError={setError} />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ContextRing threadId={thread.id} />
            {busy && (
              <Button type="button" size="sm" variant="secondary" onClick={stop}>
                <RiStopFill aria-hidden />
                {m.thread_composer_stop()}
              </Button>
            )}
            <SendButton steer={busy} disabled={!canSend} />
          </div>
        </div>
      </div>
      {unstarted && <WorkspacePicker thread={thread} worktree={worktree} />}
      {error && <FieldError className="mx-auto mt-1 max-w-3xl">{error}</FieldError>}
    </form>
  )
}

function AttachButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onClick}
            disabled={disabled}
            aria-label={m.attachment_add()}
          >
            <RiAttachment2 aria-hidden />
          </Button>
        }
      />
      <TooltipContent>{m.attachment_add_hint()}</TooltipContent>
    </Tooltip>
  )
}

function SendButton({ steer, disabled }: { steer: boolean; disabled: boolean }) {
  const label = steer ? m.thread_composer_steer() : m.thread_composer_send()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="submit" size="icon-sm" disabled={disabled} aria-label={label}>
            {steer ? <RiSteering2Line aria-hidden /> : <RiSendPlaneLine aria-hidden />}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
