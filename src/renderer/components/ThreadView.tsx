import type { LegendListRef } from "@legendapp/list/react"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, type RefObject, useEffect, useRef } from "react"
import type { Thread, ThreadStatus } from "../../shared/domain.ts"
import { findPattern } from "../lib/find.ts"
import { useDebouncedValue } from "../lib/useDebouncedValue.ts"
import { repositoryAtom } from "../lib/rpc.ts"
import { ThreadRepository } from "../lib/threadRepository.ts"
import { m } from "../paraglide/messages.js"
import { useMessages } from "../stores/messages.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { useUi } from "../stores/ui.ts"
import { ApprovalCard } from "./ApprovalCard.tsx"
import { CloudNotice } from "./CloudNotice.tsx"
import { Composer } from "./Composer.tsx"
import { FindBar } from "./FindBar.tsx"
import { FindPatternContext } from "./FindHighlight.tsx"
import { EmptyThread, MessageList } from "./MessageList.tsx"
import { QuestionRequestCard } from "./QuestionCard.tsx"
import { SecretRequestCard } from "./SecretRequestCard.tsx"
import { SubagentTranscript } from "./SubagentView.tsx"
import { ProviderIcon, providerLabel } from "./ProviderIcon.tsx"
import { UsageLimitCallout } from "./UsageLimitCallout.tsx"
import { AccountLimitNotice } from "./AccountSwitch.tsx"
import { WorktreePreparation } from "./WorktreePreparation.tsx"
import { Button } from "./ui/button.tsx"

const FIND_DEBOUNCE_MS = 100

const statusLabel = {
  idle: m.thread_status_idle,
  running: m.thread_status_running,
  awaiting_approval: m.thread_status_awaiting_approval,
  limited: m.thread_status_limited,
  archived: m.thread_status_archived,
} satisfies Record<ThreadStatus, () => string>

/** `agent` is the `callId` of the sub-agent to show instead of the thread's own transcript. */
interface ThreadViewProps {
  readonly thread: Thread
  readonly agent?: string
  readonly actions?: ReactNode
  /** Floats over the top of the transcript, below the header. */
  readonly overlay?: ReactNode
}

export function ThreadView({ thread, agent, actions, overlay }: ThreadViewProps) {
  const repository = AsyncResult.getOrElse(useAtomValue(repositoryAtom(thread.projectId)), () => null)
  const regionRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  useDockHeight(regionRef, dockRef)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h1 dir="auto" className="min-w-0 flex-1 truncate text-left text-sm font-semibold" title={thread.title}>
          {thread.title}
        </h1>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ProviderIcon provider={thread.provider} />
          {providerLabel[thread.provider]()}
        </span>
        <span
          data-status={thread.status}
          className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground data-[status=limited]:border-attention/30 data-[status=limited]:bg-attention/10 data-[status=limited]:text-attention"
        >
          {statusLabel[thread.status]()}
        </span>
        {actions}
      </header>
      <div ref={regionRef} className="relative flex min-h-0 flex-1 flex-col [container-type:size]">
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <ThreadRepository value={repository}>
            <Transcript thread={thread} agent={agent} />
          </ThreadRepository>
        </div>
        {overlay}
        <div ref={dockRef} className="absolute inset-x-0 bottom-0 flex max-h-full flex-col">
          <div className="flex min-h-0 flex-col bg-background">
            <PendingRequests thread={thread} />
            {thread.status === "limited" && thread.usageLimit !== null ? (
              <UsageLimitCallout key={thread.id} thread={thread} limit={thread.usageLimit} />
            ) : (
              <AccountLimitNotice key={thread.id} thread={thread} />
            )}
            <CloudNotice threadId={thread.id} />
          </div>
          <Composer thread={thread} />
        </div>
      </div>
    </div>
  )
}

function Transcript({ thread, agent }: { thread: Thread; agent: string | undefined }) {
  const history = useMessages((state) => state.byThread[thread.id])
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const load = useMessages((state) => state.load)
  const unload = useMessages((state) => state.unload)
  const label = providerLabel[thread.provider]()
  const findOpen = useUi((state) => state.findThreadId === thread.id)
  const findQuery = useDebouncedValue(
    useUi((state) => state.findQuery),
    FIND_DEBOUNCE_MS,
  )
  const pattern = findOpen ? findPattern(findQuery) : null
  const listRef = useRef<LegendListRef>(null)

  useEffect(() => {
    void load(thread.id)
    return () => unload(thread.id)
  }, [load, unload, thread.id])

  // The Retry button disappears into the loading state, so focus moves on before it does.
  const retry = () => {
    useUi.getState().requestComposerFocus()
    void load(thread.id)
  }

  if (history === undefined || history.status === "loading") {
    return <p className="m-auto animate-reveal text-sm text-muted-foreground">{m.thread_loading()}</p>
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
    <FindPatternContext value={pattern}>
      {findOpen && agent === undefined && <FindBar messages={history.messages} query={findQuery} listRef={listRef} />}
      {agent !== undefined ? (
        <SubagentTranscript
          key={agent}
          thread={thread}
          messages={history.messages}
          callId={agent}
          providerLabel={label}
        />
      ) : history.messages.length === 0 ? (
        <>
          {worktree?.status === "preparing" ? (
            <WorktreePreparation worktree={worktree} />
          ) : (
            <EmptyThread providerLabel={label} />
          )}
          <div className="h-(--dock-height) shrink-0" />
        </>
      ) : (
        <MessageList messages={history.messages} providerLabel={label} listRef={listRef} />
      )}
    </FindPatternContext>
  )
}

/**
 * The composer dock floats over the transcript so messages scroll behind its blur. Its height goes
 * into `--dock-height`, which the transcript pads its end with so the last message can clear it.
 */
function useDockHeight(regionRef: RefObject<HTMLDivElement | null>, dockRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const region = regionRef.current
    const dock = dockRef.current
    if (!region || !dock) return
    const observer = new ResizeObserver(() => region.style.setProperty("--dock-height", `${dock.offsetHeight}px`))
    observer.observe(dock)
    return () => observer.disconnect()
  }, [regionRef, dockRef])
}

function PendingRequests({ thread }: { thread: Thread }) {
  const history = useMessages((state) => state.byThread[thread.id])
  const label = providerLabel[thread.provider]()
  if (history?.status !== "ready") return null
  return (
    <div className="min-h-0 shrink overflow-auto px-4 empty:hidden">
      {history.approvals.map((request) => (
        <ApprovalCard key={request.id} request={request} providerLabel={label} />
      ))}
      {history.questions.map((request) => (
        <QuestionRequestCard key={request.id} request={request} providerLabel={label} />
      ))}
      {history.secretRequests.map((request) => (
        <SecretRequestCard key={request.id} request={request} providerLabel={label} />
      ))}
    </div>
  )
}
