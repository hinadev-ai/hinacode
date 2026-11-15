import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Cause, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef } from "react"
import type { Message, Thread } from "../../shared/domain.ts"
import {
  findSubagentWork,
  inputField,
  mergeSubagentWork,
  statusOfCall,
  subagentReport,
} from "../../shared/subagents.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { useOpenSubagent } from "../lib/subagents.ts"
import { m } from "../paraglide/messages.js"
import { useMessages } from "../stores/messages.ts"
import { subagentWorkAtom, unloadedSubagentWorkAtom, useSubagentByCallId } from "../stores/subagents.ts"
import { useUi } from "../stores/ui.ts"
import { MessageList } from "./MessageList.tsx"
import { formatOutput } from "./MessagePart.tsx"
import { SubagentProviderIcon } from "./ProviderIcon.tsx"
import { StopSubagentButton, SubagentStatusIcon, SubagentStats, useSecondTick } from "./ThreadAgents.tsx"
import { Button } from "./ui/button.tsx"
import { ArrowLeftIcon } from "@hinacode/icons"

const useWorkRevision = (threadId: string) =>
  useMessages((state) => {
    const history = state.byThread[threadId]
    return history?.status === "ready" ? `${history.snapshotId}:${history.missedFinishes}` : undefined
  })

export function useSubagentLabel(threadId: string, callId: string | undefined) {
  const reported = useSubagentByCallId(threadId, callId)?.label
  const described = useMessages((state) => {
    const history = state.byThread[threadId]
    return history?.status === "ready" && callId !== undefined
      ? inputField(findSubagentWork(history.messages, callId).spawn, "description")
      : undefined
  })
  const revision = useWorkRevision(threadId)
  const fetched = useAtomValue(
    reported === undefined && described === undefined && callId !== undefined && revision !== undefined
      ? subagentWorkAtom(threadId, callId, revision)
      : unloadedSubagentWorkAtom,
  )
  const fetchedSpawn = Option.getOrUndefined(AsyncResult.value(fetched))?.spawn
  const fetchedDescription = inputField(fetchedSpawn?.type === "tool_call" ? fetchedSpawn : undefined, "description")
  return reported ?? described ?? fetchedDescription ?? m.agents_untitled()
}

export function SubagentTranscript({
  thread,
  messages,
  callId,
  providerLabel,
}: {
  thread: Thread
  messages: ReadonlyArray<Message>
  callId: string
  providerLabel: string
}) {
  const subagent = useSubagentByCallId(thread.id, callId)
  const revision = useWorkRevision(thread.id)
  const workAtom = revision === undefined ? unloadedSubagentWorkAtom : subagentWorkAtom(thread.id, callId, revision)
  const fetchedWork = useAtomValue(workAtom)
  const retry = useAtomRefresh(workAtom)
  const fetched = Option.getOrUndefined(AsyncResult.value(fetchedWork))
  const { spawn, calls, startedAt } = mergeSubagentWork(fetched, findSubagentWork(messages, callId))
  const hasWork = spawn !== undefined || calls.length > 0
  const failure = AsyncResult.isFailure(fetchedWork) && !fetchedWork.waiting ? fetchedWork.cause : undefined
  const loading = !hasWork && fetched === undefined && failure === undefined
  const open = useOpenSubagent(thread.id)
  const now = useSecondTick(subagent?.status === "running")
  const headingRef = useRef<HTMLHeadingElement>(null)

  const status = subagent?.status ?? (spawn && statusOfCall[spawn.status])
  const label = subagent?.label ?? inputField(spawn, "description") ?? m.agents_untitled()
  const prompt = inputField(spawn, "prompt")
  const result =
    spawn?.output !== undefined
      ? subagentReport(formatOutput(spawn.output))
      : status !== "running"
        ? (subagent?.summary ?? undefined)
        : undefined
  const parentCallId = spawn?.parentCallId
  const parentAgentLabel = useSubagentLabel(thread.id, parentCallId)
  const parentLabel = parentCallId === undefined ? thread.title : parentAgentLabel

  const createdAt = startedAt ?? subagent?.startedAt
  const transcript: ReadonlyArray<Message> =
    createdAt === undefined
      ? []
      : [
          ...(prompt
            ? [
                {
                  id: `subagent:${callId}:prompt`,
                  threadId: thread.id,
                  role: "user" as const,
                  parts: [{ type: "text" as const, text: prompt }],
                  createdAt,
                  completedAt: createdAt,
                  usage: null,
                  forkPoint: null,
                },
              ]
            : []),
          {
            id: `subagent:${callId}`,
            threadId: thread.id,
            role: "assistant",
            parts: result ? [...calls, { type: "text", text: result }] : calls,
            createdAt,
            completedAt: status === "running" ? null : createdAt,
            usage: null,
            forkPoint: null,
          },
        ]

  useEffect(() => headingRef.current?.focus({ preventScroll: true }), [])

  const back = () => {
    if (parentCallId === undefined) useUi.getState().requestComposerFocus()
    open(parentCallId)
  }

  const header = (
    <div className="mx-auto flex w-full max-w-3xl clear-overview flex-col gap-1.5 px-4 pt-4">
      <div className="flex min-w-0 items-center gap-2">
        {status && <SubagentStatusIcon status={status} />}
        <SubagentProviderIcon subagent={subagent} thread={thread} />
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="min-w-0 truncate text-sm font-semibold outline-none"
          title={label}
        >
          {label}
        </h2>
        {subagent && (
          <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground tabular-nums">
            <SubagentStats thread={thread} subagent={subagent} now={now} />
          </span>
        )}
        {subagent?.status === "running" && <StopSubagentButton threadId={thread.id} subagent={subagent} />}
      </div>
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto w-full max-w-3xl shrink-0 clear-overview px-4 pt-3">
        <Button
          variant="ghost"
          size="xs"
          onClick={back}
          aria-label={m.agents_back({ name: parentLabel })}
          className="-ml-2 max-w-full text-muted-foreground"
        >
          <ArrowLeftIcon aria-hidden />
          <span className="truncate">{parentLabel}</span>
        </Button>
      </div>
      {failure !== undefined ? (
        <>
          {header}
          <div role="alert" className="m-auto flex max-w-3xl clear-overview flex-col items-center gap-2 px-4">
            <p className="text-center text-sm wrap-break-word text-destructive">
              {m.thread_load_failed({ message: errorMessage(Cause.squash(failure)) })}
            </p>
            <Button variant="outline" size="sm" onClick={retry}>
              {m.common_retry()}
            </Button>
          </div>
        </>
      ) : loading ? (
        header
      ) : transcript.length === 0 ? (
        <>
          {header}
          <p className="m-auto clear-overview px-4 text-sm text-muted-foreground">{m.agents_missing()}</p>
        </>
      ) : (
        <MessageList
          messages={transcript}
          providerLabel={providerLabel}
          header={header}
          alignItemsAtEnd={false}
          showElapsedTime={false}
        />
      )}
    </div>
  )
}
