import { useEffect } from "react"
import type { Thread, ThreadStatus } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { useMessages } from "../stores/messages.ts"
import { useUi } from "../stores/ui.ts"
import { ApprovalCard } from "./ApprovalCard.tsx"
import { Composer } from "./Composer.tsx"
import { EmptyThread, MessageList } from "./MessageList.tsx"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { PanelToggle } from "./ThreadSidePanel.tsx"
import { Button } from "./ui/button.tsx"

const providerLabel = { claude: m.provider_claude, codex: m.provider_codex }

const statusLabel = {
  idle: m.thread_status_idle,
  running: m.thread_status_running,
  awaiting_approval: m.thread_status_awaiting_approval,
  settled: m.thread_status_settled,
  archived: m.thread_status_archived,
} satisfies Record<ThreadStatus, () => string>

export function ThreadHeader({ thread }: { thread: Thread }) {
  const panelOpen = useUi((state) => state.sidePanelOpen)
  const togglePanel = useUi((state) => state.toggleSidePanel)
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border pr-2 pl-5">
      <h1 className="min-w-0 truncate text-sm font-medium" title={thread.title}>
        {thread.title}
      </h1>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <ProviderIcon provider={thread.provider} />
        {providerLabel[thread.provider]()}
      </span>
      <StatusIndicator status={thread.status} />
      <PanelToggle expanded={panelOpen} onToggle={togglePanel} />
    </header>
  )
}

const statusTone = {
  idle: null,
  running: "bg-success animate-pulse motion-reduce:animate-none",
  awaiting_approval: "bg-warning",
  settled: "bg-muted-foreground/50",
  archived: "bg-muted-foreground/50",
} satisfies Record<ThreadStatus, string | null>

/** Idle is the resting state, so only the states worth noticing take space in the header. */
function StatusIndicator({ status }: { status: ThreadStatus }) {
  const tone = statusTone[status]
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {tone && (
        <>
          <span aria-hidden className={`size-1.5 rounded-full ${tone}`} />
          {statusLabel[status]()}
        </>
      )}
    </span>
  )
}

export function ThreadView({ thread }: { thread: Thread }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Transcript thread={thread} />
      <Composer thread={thread} />
    </div>
  )
}

function Transcript({ thread }: { thread: Thread }) {
  const history = useMessages((state) => state.byThread[thread.id])
  const load = useMessages((state) => state.load)
  const label = providerLabel[thread.provider]()

  useEffect(() => {
    void load(thread.id)
  }, [load, thread.id])

  if (history === undefined || history.status === "loading") {
    return <p className="m-auto text-sm text-muted-foreground">{m.thread_loading()}</p>
  }
  if (history.status === "error") {
    return (
      <div role="alert" className="m-auto flex flex-col items-center gap-2">
        <p className="text-sm text-destructive">{m.thread_load_failed({ message: history.message })}</p>
        <Button variant="outline" size="sm" onClick={() => void load(thread.id)}>
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
      <div className="px-6">
        {history.approvals.map((request) => (
          <ApprovalCard key={request.id} request={request} providerLabel={label} />
        ))}
      </div>
    </>
  )
}
