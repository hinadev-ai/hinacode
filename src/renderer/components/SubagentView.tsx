import { useEffect, useMemo, useRef } from "react"
import { RiArrowLeftLine, RiArrowRightSLine } from "react-icons/ri"
import type { Message, Thread } from "../../shared/domain.ts"
import { findSubagentWork, inputField, statusOfCall, subagentReport, useOpenSubagent } from "../lib/subagents.ts"
import { m } from "../paraglide/messages.js"
import { useSubagentByCallId } from "../stores/subagents.ts"
import { useUi } from "../stores/ui.ts"
import { Markdown } from "./Markdown.tsx"
import { MessageList } from "./MessageList.tsx"
import { formatOutput } from "./MessagePart.tsx"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { SubagentStatusIcon, subagentStats, useNow } from "./ThreadAgents.tsx"
import { Button } from "./ui/button.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"

/**
 * One sub-agent's prompt, tool calls and result, opened in place of the thread's transcript.
 * Key it by `callId` so each sub-agent opens with focus on its heading.
 */
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
  const { spawn, calls, startedAt } = useMemo(() => findSubagentWork(messages, callId), [messages, callId])
  const open = useOpenSubagent(thread.id)
  const now = useNow(subagent?.status === "running")
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
  const parentLabel =
    parentCallId === undefined
      ? thread.title
      : (inputField(findSubagentWork(messages, parentCallId).spawn, "description") ?? m.agents_untitled())

  const createdAt = startedAt ?? subagent?.startedAt
  const transcript = useMemo<ReadonlyArray<Message>>(
    () =>
      createdAt === undefined
        ? []
        : [
            {
              id: `subagent:${callId}`,
              threadId: thread.id,
              role: "assistant",
              parts: result ? [...calls, { type: "text", text: result }] : calls,
              createdAt,
              completedAt: status === "running" ? null : createdAt,
              usage: null,
            },
          ],
    [callId, thread.id, calls, result, createdAt, status],
  )

  useEffect(() => headingRef.current?.focus({ preventScroll: true }), [])

  const back = () => {
    if (parentCallId === undefined) useUi.getState().requestComposerFocus()
    open(parentCallId)
  }

  const header = (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 px-4 pt-4">
      <div className="flex min-w-0 items-center gap-2">
        {status && <SubagentStatusIcon status={status} />}
        <ProviderIcon provider={thread.provider} />
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="min-w-0 truncate text-sm font-semibold outline-none"
          title={label}
        >
          {label}
        </h2>
        {subagent && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {subagentStats(subagent, now)}
          </span>
        )}
      </div>
      {prompt && <PromptDisclosure prompt={prompt} />}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-3">
        <Button
          variant="ghost"
          size="xs"
          onClick={back}
          aria-label={m.agents_back({ name: parentLabel })}
          className="-ml-2 max-w-full text-muted-foreground"
        >
          <RiArrowLeftLine aria-hidden />
          <span className="truncate">{parentLabel}</span>
        </Button>
      </div>
      {transcript.length === 0 ? (
        <>
          {header}
          <p className="m-auto px-4 text-sm text-muted-foreground">{m.agents_missing()}</p>
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

function PromptDisclosure({ prompt }: { prompt: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/trigger -ml-2 flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
        <RiArrowRightSLine
          aria-hidden
          className="size-3.5 shrink-0 transition-transform group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
        />
        {m.agents_prompt()}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 max-h-64 overflow-auto border-l-2 border-border pl-3 text-sm">
        <Markdown text={prompt} />
      </CollapsibleContent>
    </Collapsible>
  )
}
