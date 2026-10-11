import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, type KeyboardEvent, useState, useTransition } from "react"
import { RiSendPlaneLine, RiStopFill } from "react-icons/ri"
import type { ModelInfo } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import { callPromise, modelsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { Button } from "./ui/button.tsx"
import { FieldError } from "./ui/field.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx"
import { Textarea } from "./ui/textarea.tsx"

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export function Composer({ thread }: { thread: Thread }) {
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isSending, startSending] = useTransition()
  const busy = thread.status === "running" || thread.status === "awaiting_approval"
  const canSend = draft.trim() !== "" && !busy && !isSending

  const send = () => {
    const prompt = draft.trim()
    if (!canSend) return
    setError(null)
    startSending(async () => {
      try {
        await callPromise("threads.send", { threadId: thread.id, prompt })
        setDraft("")
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  const stop = () => {
    callPromise("threads.interrupt", { threadId: thread.id }).catch((cause: unknown) => setError(errorMessage(cause)))
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    send()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing: Enter confirms an IME candidate (zh-TW, ja) and must not send.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    send()
  }

  return (
    <form onSubmit={onSubmit} className="shrink-0 px-4 pb-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-1 rounded-xl border border-input bg-input/30 p-2 focus-within:border-ring">
        <Textarea
          aria-label={m.thread_composer_label()}
          placeholder={m.thread_composer_placeholder()}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          className="max-h-60 min-h-0 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center gap-2">
          <ModelPicker thread={thread} onError={setError} />
          <div className="ml-auto">
            {busy ? (
              <Button type="button" size="sm" variant="secondary" onClick={stop}>
                <RiStopFill aria-hidden />
                {m.thread_composer_stop()}
              </Button>
            ) : (
              <Button type="submit" size="icon-sm" disabled={!canSend} aria-label={m.thread_composer_send()}>
                <RiSendPlaneLine aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </div>
      {error && <FieldError className="mx-auto mt-1 max-w-3xl">{m.common_error({ message: error })}</FieldError>}
    </form>
  )
}

function ModelPicker({ thread, onError }: { thread: Thread; onError: (message: string) => void }) {
  const result = useAtomValue(modelsAtom(thread.provider))
  const listed = AsyncResult.getOrElse(result, (): ReadonlyArray<ModelInfo> => [])
  // Keep the thread's model selectable even when the provider no longer lists it.
  const models = listed.some((model) => model.id === thread.model)
    ? listed
    : [{ id: thread.model, label: thread.model, provider: thread.provider }, ...listed]
  const items = models.map((model) => ({ value: model.id, label: model.label }))

  const change = async (model: string | null) => {
    if (model === null || model === thread.model) return
    try {
      useThreads.getState().upsert(await callPromise("threads.update", { id: thread.id, model }))
    } catch (cause) {
      onError(errorMessage(cause))
    }
  }

  return (
    <Select items={items} value={thread.model} onValueChange={change}>
      <SelectTrigger size="sm" aria-label={m.thread_model_picker()} className="border-0 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
