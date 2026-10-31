import type { LegendListRef } from "@legendapp/list/react"
import { useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, type RefObject, useEffect, useRef } from "react"
import type { AgentCommand } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import { findPattern } from "../lib/find.ts"
import { useDebouncedValue } from "../lib/useDebouncedValue.ts"
import { useIsChat } from "../lib/useIsChat.ts"
import { commandsAtom, completionKey, projectsAtom, repositoryAtom, threadCommands } from "../lib/rpc.ts"
import { ThreadRepository } from "../lib/threadRepository.ts"
import { ThreadFolder, useThreadRoot } from "../lib/threadRoot.ts"
import { m } from "../paraglide/messages.js"
import { useMessages } from "../stores/messages.ts"
import { useWorktrees } from "../stores/worktrees.ts"
import { useUi } from "../stores/ui.ts"
import { ApprovalCard } from "./ApprovalCard.tsx"
import { CloudNotice } from "./CloudNotice.tsx"
import { Composer } from "./Composer.tsx"
import { ThreadEnvironmentSwitch, ThreadProjectSwitch } from "./ComposerControls.tsx"
import { FindBar } from "./FindBar.tsx"
import { FindPatternContext } from "./FindHighlight.tsx"
import { EmptyThread, MessageList } from "./MessageList.tsx"
import { QuestionRequestCard } from "./QuestionCard.tsx"
import { SecretRequestCard } from "./SecretRequestCard.tsx"
import { SubagentTranscript, useSubagentLabel } from "./SubagentView.tsx"
import { ProviderIcon, providerLabel } from "./ProviderIcon.tsx"
import { UsageLimitCallout } from "./UsageLimitCallout.tsx"
import { AccountLimitNotice } from "./AccountSwitch.tsx"
import { WorktreePreparation } from "./WorktreePreparation.tsx"
import { Button } from "./ui/button.tsx"

const FIND_DEBOUNCE_MS = 100

const besideOverview = "@min-[48rem]:@max-[83rem]:pe-70"

interface ThreadViewProps {
  readonly thread: Thread
  readonly agent?: string
  readonly actions?: ReactNode
  readonly overlay?: ReactNode
}

export function ThreadView({ thread, agent, actions, overlay }: ThreadViewProps) {
  const repository = AsyncResult.getOrElse(useAtomValue(repositoryAtom(thread.projectId)), () => null)
  const folder = useThreadRoot(thread)?.path ?? null
  const regionRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  useDockHeight(regionRef, dockRef)
  const findOpen = useUi((state) => state.findThreadId === thread.id)
  const loaded = useMessages((state) => state.byThread[thread.id]?.status === "ready")
  const centered = useMessages((state) => {
    const history = state.byThread[thread.id]
    return agent === undefined && history?.status === "ready" && history.messages.length === 0
  })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="@container flex min-h-12 shrink-0 flex-wrap items-center gap-2 px-3 py-2 window-drag">
        <ThreadBreadcrumb thread={thread} agent={agent} />
        {actions}
      </header>
      <div ref={regionRef} className="@container-size relative flex min-h-0 flex-1 flex-col">
        <div className={cn("flex min-h-0 flex-1 flex-col overflow-auto", besideOverview)}>
          <ThreadRepository value={repository}>
            <ThreadFolder value={folder}>
              <Transcript thread={thread} agent={agent} />
            </ThreadFolder>
          </ThreadRepository>
        </div>
        <div
          className={cn(
            "absolute inset-e-4 z-10 flex max-w-[calc(100%-2rem)] flex-col items-end gap-2 empty:hidden",
            findOpen ? "top-13" : "top-3",
            centered ? "max-h-[calc(50%-var(--dock-height)/2-1.5rem)]" : "max-h-[calc(100%-var(--dock-height)-1.5rem)]",
          )}
        >
          {overlay}
        </div>
        <div
          ref={dockRef}
          data-centered={centered}
          data-loaded={loaded}
          className={cn(
            besideOverview,
            "absolute inset-x-0 bottom-0 flex max-h-full flex-col data-[centered=true]:translate-y-[calc(var(--dock-height)/2-50cqh)] data-[loaded=false]:opacity-0 data-[loaded=true]:data-[centered=false]:transition-transform data-[loaded=true]:data-[centered=false]:duration-500 data-[loaded=true]:data-[centered=false]:ease-drawer motion-reduce:transition-none",
          )}
        >
          <Composer thread={thread} subagentCallId={agent}>
            <PendingRequests thread={thread} />
            {thread.status === "limited" && thread.usageLimit !== null ? (
              <UsageLimitCallout key={thread.id} thread={thread} limit={thread.usageLimit} />
            ) : (
              <AccountLimitNotice key={thread.id} thread={thread} />
            )}
            <CloudNotice threadId={thread.id} />
          </Composer>
        </div>
      </div>
    </div>
  )
}

function ThreadBreadcrumb({ thread, agent }: { thread: Thread; agent: string | undefined }) {
  const project = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => []).find(
    (candidate) => candidate.id === thread.projectId,
  )
  return (
    <nav aria-label={m.thread_breadcrumb()} className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        <li title={providerLabel[thread.provider]()} className="flex shrink-0">
          <ProviderIcon provider={thread.provider} />
          <span className="sr-only">{providerLabel[thread.provider]()}</span>
        </li>
        {project && (
          <li dir="auto" className="max-w-48 shrink-0 truncate text-muted-foreground" title={project.name}>
            {project.name}
          </li>
        )}
        <li className="flex min-w-0 items-center gap-1.5">
          {project && <Separator />}
          <h1 dir="auto" className="truncate font-semibold" title={thread.title}>
            {thread.title}
          </h1>
        </li>
        {agent !== undefined && <SubagentCrumb threadId={thread.id} callId={agent} />}
      </ol>
    </nav>
  )
}

function SubagentCrumb({ threadId, callId }: { threadId: string; callId: string }) {
  const label = useSubagentLabel(threadId, callId)
  return (
    <li dir="auto" className="flex min-w-0 items-center gap-1.5">
      <Separator />
      <span className="truncate" title={label}>
        {label}
      </span>
    </li>
  )
}

const Separator = () => (
  <span aria-hidden className="text-muted-foreground/60">
    /
  </span>
)

function Transcript({ thread, agent }: { thread: Thread; agent: string | undefined }) {
  const history = useMessages((state) => state.byThread[thread.id])
  const worktree = useWorktrees((state) => (thread.worktreeId ? state.byId[thread.worktreeId] : undefined))
  const load = useMessages((state) => state.load)
  const label = providerLabel[thread.provider]()
  const commands = threadCommands(
    AsyncResult.getOrElse(useAtomValue(commandsAtom(completionKey(thread))), (): ReadonlyArray<AgentCommand> => []),
    thread,
  )
  const isChat = useIsChat(thread.projectId)
  const findOpen = useUi((state) => state.findThreadId === thread.id)
  const findQuery = useDebouncedValue(
    useUi((state) => state.findQuery),
    FIND_DEBOUNCE_MS,
  )
  const pattern = findOpen ? findPattern(findQuery) : null
  const listRef = useRef<LegendListRef>(null)

  useEffect(() => {
    void load(thread.id)
  }, [load, thread.id])

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
            <div className="mt-auto">
              <EmptyThread
                project={isChat ? null : <ThreadProjectSwitch thread={thread} />}
                environment={<ThreadEnvironmentSwitch thread={thread} />}
              />
            </div>
          )}
          <div className="h-[calc(50cqh+var(--dock-height)/2+1.5rem)] shrink-0" />
        </>
      ) : (
        <MessageList messages={history.messages} providerLabel={label} commands={commands} listRef={listRef} />
      )}
    </FindPatternContext>
  )
}

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

export function PendingRequests({ thread }: { thread: Thread }) {
  const history = useMessages((state) => state.byThread[thread.id])
  const label = providerLabel[thread.provider]()
  if (history?.status !== "ready") return null
  return (
    <div aria-live="polite" className="min-h-0 shrink overflow-auto empty:hidden">
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
