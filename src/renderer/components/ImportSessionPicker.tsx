import { Autocomplete } from "@base-ui/react/autocomplete"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useAtomValue } from "@effect/atom-react"
import { useState } from "react"
import { RiArrowRightUpLine, RiInboxArchiveLine } from "react-icons/ri"
import { toast } from "sonner"
import type { RpcResponse } from "../../shared/contract.ts"
import type { ExternalSession, Project } from "../../shared/domain.ts"
import { environmentOf } from "../lib/environments.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { formatRelativeTime } from "../lib/relativeTime.ts"
import { accountsAtom, callPromise, externalSessionsAtom } from "../lib/rpc.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useThreads } from "../stores/threads.ts"
import { ProviderIcon, providerLabel } from "./ProviderIcon.tsx"

type Listing = RpcResponse<"sessions.listExternal">

const focusOnMount = (input: HTMLInputElement | null) => input?.focus()
const sessionKey = (session: ExternalSession) => `${session.provider}:${session.sessionId}`

const matches = (session: ExternalSession, query: string) => {
  const needle = query.trim().toLowerCase()
  return needle === "" || `${session.title}\n${session.preview}\n${session.branch ?? ""}`.toLowerCase().includes(needle)
}

interface SessionRowProps {
  readonly project: Project
  readonly session: ExternalSession
  readonly importing: boolean
  readonly onChoose: (session: ExternalSession) => void
}

function SessionRow({ project, session, importing, onChoose }: SessionRowProps) {
  const now = useNow()
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom(environmentOf(project))), () => [])
  const account = accounts.find((candidate) => candidate.id === session.accountId)
  const details = [formatRelativeTime(session.updatedAt, now, getLocale()), account?.name, session.branch].filter(
    (detail) => detail !== undefined && detail !== null,
  )
  return (
    <Autocomplete.Item
      value={session}
      onClick={() => onChoose(session)}
      className="flex cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:inset-ring data-highlighted:inset-ring-ring/50"
    >
      <span className="flex h-5 shrink-0 items-center">
        <ProviderIcon provider={session.provider} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{session.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {importing ? m.import_session_importing() : details.join(" · ")}
          </span>
        </span>
        {session.preview !== "" && session.preview !== session.title && (
          <span className="line-clamp-2 text-xs text-muted-foreground">{session.preview}</span>
        )}
      </span>
      {session.threadId !== null && (
        <span className="flex h-5 shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
          {m.import_session_open()}
          <RiArrowRightUpLine aria-hidden className="size-3.5" />
        </span>
      )}
    </Autocomplete.Item>
  )
}

export default function ImportSessionPicker({ project, onClose }: { project: Project; onClose: () => void }) {
  const navigate = useNavigate()
  const result = useAtomValue(externalSessionsAtom(project.id))
  const listing = AsyncResult.getOrElse(result, (): Listing | null => null)
  const [query, setQuery] = useState("")
  const [importing, setImporting] = useState<string | null>(null)
  const sessions = (listing?.sessions ?? []).filter((session) => matches(session, query))

  const open = async (threadId: string) => {
    onClose()
    await navigate({ to: "/thread/$threadId", params: { threadId } })
  }

  const choose = async (session: ExternalSession) => {
    if (importing !== null) return
    if (session.threadId !== null) return open(session.threadId)
    setImporting(sessionKey(session))
    try {
      const thread = await callPromise("sessions.import", {
        projectId: project.id,
        provider: session.provider,
        sessionId: session.sessionId,
        accountId: session.accountId,
      })
      useThreads.getState().upsert(thread)
      await open(thread.id)
    } catch (cause) {
      toast.error(m.import_session_failed({ message: errorMessage(cause) }))
      setImporting(null)
    }
  }

  return (
    <>
      <DialogPrimitive.Title className="truncate px-3.5 pt-3 text-xs text-muted-foreground">
        {m.import_session_title({ project: project.name })}
      </DialogPrimitive.Title>
      <Autocomplete.Root
        open
        inline
        items={sessions}
        filter={null}
        autoHighlight="always"
        keepHighlight
        value={query}
        onValueChange={(value, details) => {
          if (details.reason !== "item-press") setQuery(value)
        }}
        itemToStringValue={(session: ExternalSession) => session.title}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5">
          <RiInboxArchiveLine aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <Autocomplete.Input
            ref={focusOnMount}
            aria-label={m.import_session_input_label()}
            placeholder={m.import_session_placeholder()}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose()
            }}
            className="h-12 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {listing?.failures.map((failure) => (
          <p key={`${failure.provider}:${failure.accountId}`} className="px-3.5 pt-2 text-xs text-muted-foreground">
            {m.import_session_home_failed({ agent: providerLabel[failure.provider](), message: failure.message })}
          </p>
        ))}
        <p className="px-3.5 py-6 text-center text-sm text-muted-foreground empty:hidden">
          {listing === null
            ? AsyncResult.builder(result)
                .onError((cause) => m.import_session_list_failed({ message: errorMessage(cause) }))
                .orElse(() => m.import_session_loading())
            : listing.sessions.length === 0
              ? m.import_session_empty({ path: project.rootPath })
              : sessions.length === 0
                ? m.import_session_no_match()
                : ""}
        </p>
        <Autocomplete.List className="min-h-0 scroll-py-1 overflow-y-auto overscroll-contain p-1.5 data-empty:hidden">
          {(session: ExternalSession) => (
            <SessionRow
              key={sessionKey(session)}
              project={project}
              session={session}
              importing={importing === sessionKey(session)}
              onChoose={(chosen) => void choose(chosen)}
            />
          )}
        </Autocomplete.List>
      </Autocomplete.Root>
    </>
  )
}
