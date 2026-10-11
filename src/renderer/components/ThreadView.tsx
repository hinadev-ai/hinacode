import { RiSendPlaneLine } from "react-icons/ri"
import type { Thread, ThreadStatus } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { Button } from "./ui/button.tsx"
import { Textarea } from "./ui/textarea.tsx"

const providerLabel = { claude: m.provider_claude, codex: m.provider_codex }

const statusLabel = {
  idle: m.thread_status_idle,
  running: m.thread_status_running,
  awaiting_approval: m.thread_status_awaiting_approval,
  settled: m.thread_status_settled,
  archived: m.thread_status_archived,
} satisfies Record<ThreadStatus, () => string>

/** Placeholder until the message list and agent runner land: header plus a disabled composer. */
export function ThreadView({ thread }: { thread: Thread }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <h1 className="truncate text-sm font-semibold" title={thread.title}>
          {thread.title}
        </h1>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ProviderIcon provider={thread.provider} />
          {providerLabel[thread.provider]()}
          <span aria-hidden>·</span>
          <span className="font-mono">{thread.model}</span>
        </span>
        <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {statusLabel[thread.status]()}
        </span>
      </header>

      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{m.thread_empty()}</div>

      <form className="shrink-0 border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-xl border border-input bg-input/30 p-2">
          <Textarea
            aria-label={m.thread_composer_label()}
            placeholder={m.thread_composer_placeholder()}
            disabled
            rows={2}
            className="min-h-0 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
          />
          <Button type="submit" size="icon" disabled aria-label={m.thread_composer_send()}>
            <RiSendPlaneLine aria-hidden />
          </Button>
        </div>
      </form>
    </div>
  )
}
