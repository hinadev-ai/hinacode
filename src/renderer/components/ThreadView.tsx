import { type ReactNode, useEffect } from "react"
import { isThreadBusy, type Thread, type ThreadStatus } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { useMessages } from "../stores/messages.ts"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { ApprovalCard } from "./ApprovalCard.tsx"
import { Composer } from "./Composer.tsx"
import { EmptyThread, MessageList } from "./MessageList.tsx"
import { SecretRequestCard } from "./SecretRequestCard.tsx"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { Button } from "./ui/button.tsx"

const providerLabel = { claude: m.provider_claude, codex: m.provider_codex }

const statusLabel = {
  idle: m.thread_status_idle,
  running: m.thread_status_running,
  awaiting_approval: m.thread_status_awaiting_approval,
  settled: m.thread_status_settled,
  archived: m.thread_status_archived,
} satisfies Record<ThreadStatus, () => string>

export function ThreadView({ thread, actions }: { thread: Thread; actions?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold" title={thread.title}>
          {thread.title}
        </h1>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ProviderIcon provider={thread.provider} />
          {providerLabel[thread.provider]()}
        </span>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {statusLabel[thread.status]()}
        </span>
        {actions}
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Transcript thread={thread} />
      </div>
      <Composer thread={thread} />
    </div>
  )
}

function Transcript({ thread }: { thread: Thread }) {
  const history = useMessages((state) => state.byThread[thread.id])
  const load = useMessages((state) => state.load)
  const unload = useMessages((state) => state.unload)
  const label = providerLabel[thread.provider]()

  useEffect(() => {
    void load(thread.id)
    // Leaving a thread frees its transcript. A thread mid-turn keeps its copy so the events still
    // streaming in have something to fold into.
    return () => {
      const status = useThreads.getState().byId[thread.id]?.status
      if (status === undefined || !isThreadBusy(status)) unload(thread.id)
    }
  }, [load, unload, thread.id])

  // The Retry button disappears into the loading state, so focus moves on before it does.
  const retry = () => {
    useUi.getState().requestComposerFocus()
    void load(thread.id)
  }

  if (history === undefined || history.status === "loading") {
    return <p className="m-auto text-sm text-muted-foreground">{m.thread_loading()}</p>
  }
  if (history.status === "error") {
    return (
      <div role="alert" className="m-auto flex flex-col items-center gap-2">
        <p className="text-sm text-destructive">{m.thread_load_failed({ message: history.message })}</p>
        <Button variant="outline" size="sm" onClick={retry}>
          {m.common_retry()}
        </Button>
      </div>
    )
  }
  return (
    <>
      {history.messages.length === 0 ? (
        <EmptyThread providerLabel={label} />
      ) : (
        <MessageList messages={history.messages} />
      )}
      <div className="px-4">
        {history.approvals.map((request) => (
          <ApprovalCard key={request.id} request={request} providerLabel={label} />
        ))}
        {history.secretRequests.map((request) => (
          <SecretRequestCard key={request.id} request={request} providerLabel={label} />
        ))}
      </div>
    </>
  )
}
