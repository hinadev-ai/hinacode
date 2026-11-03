import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { RiDownload2Line } from "react-icons/ri"
import { toast } from "sonner"
import type { Artifact } from "../../../shared/artifact.ts"
import { artifactUrl } from "../../../shared/channels.ts"
import type { Thread } from "../../../shared/domain.ts"
import { environmentName, useClouds } from "../../lib/environments.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { formatRelativeTime } from "../../lib/relativeTime.ts"
import { useArtifactTheme } from "../../lib/artifactTheme.ts"
import { artifactsAtom, callPromise } from "../../lib/rpc.ts"
import { useNow } from "../../lib/useNow.ts"
import { m } from "../../paraglide/messages.js"
import { getLocale } from "../../paraglide/runtime.js"
import { useArtifacts } from "../../stores/artifacts.ts"
import { useThreads } from "../../stores/threads.ts"
import { ArrowLeftIcon } from "../icons/ArrowLeftIcon.tsx"
import { ArrowRightIcon } from "../icons/ArrowRightIcon.tsx"
import { TrashIcon } from "../icons/TrashIcon.tsx"
import { Button } from "../ui/button.tsx"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../ui/context-menu.tsx"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.tsx"
import { SkeletonList } from "../ui/skeleton.tsx"
import { Section, ViewBody } from "./Section.tsx"

const noArtifacts: ReadonlyArray<Artifact> = []

function useSelectedArtifact(threadId: string) {
  const id = useArtifacts((state) => state.selected[threadId])
  const artifacts = AsyncResult.getOrElse(useAtomValue(artifactsAtom), () => noArtifacts)
  return artifacts.find((artifact) => artifact.id === id)
}

export function ArtifactsHeader({ thread }: { thread: Thread }) {
  const selected = useSelectedArtifact(thread.id)
  const select = useArtifacts((state) => state.select)
  if (selected === undefined) return <h2 className="truncate pl-2 text-sm font-medium">{m.panel_tab_artifacts()}</h2>
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={m.artifacts_back()}
        title={m.artifacts_back()}
        action={() => select(thread.id, null)}
      >
        <ArrowLeftIcon aria-hidden />
      </Button>
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{selected.title}</h2>
      <ExportMenu artifact={selected} />
    </div>
  )
}

function ExportMenu({ artifact }: { artifact: Artifact }) {
  const theme = useArtifactTheme()
  const save = (format: "html" | "pdf") =>
    callPromise("artifacts.export", { id: artifact.id, entry: artifact.entry, title: artifact.title, format, theme })
      .then((path) => {
        if (path !== null) toast(m.artifacts_exported({ path }))
      })
      .catch((cause: unknown) => toast.error(m.artifacts_export_failed({ message: errorMessage(cause) })))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={m.artifacts_export()} title={m.artifacts_export()} />
        }
      >
        <RiDownload2Line aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void save("html")}>{m.artifacts_export_html()}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void save("pdf")}>{m.artifacts_export_pdf()}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ArtifactsView({ thread }: { thread: Thread }) {
  const selected = useSelectedArtifact(thread.id)
  const theme = useArtifactTheme()
  if (selected !== undefined) {
    return (
      <iframe
        src={`${artifactUrl(selected.id, selected.entry)}?v=${selected.version}&theme=${encodeURIComponent(theme)}`}
        title={selected.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="min-h-0 flex-1 border-0 bg-background"
      />
    )
  }
  return (
    <ViewBody>
      <ArtifactList threadId={thread.id} />
    </ViewBody>
  )
}

function ArtifactList({ threadId }: { threadId: string }) {
  const artifacts = useAtomValue(artifactsAtom)
  const refresh = useAtomRefresh(artifactsAtom)
  const failed = (message: string) => (
    <div role="alert" className="flex items-center gap-2">
      <p className="min-w-0 flex-1 text-xs wrap-anywhere text-destructive">{m.artifacts_failed({ message })}</p>
      <Button variant="outline" size="xs" onClick={refresh}>
        {m.sidebar_retry()}
      </Button>
    </div>
  )
  return AsyncResult.builder(artifacts)
    .onInitial(() => <SkeletonList label={m.artifacts_loading()} rows={3} rowClassName="h-9" />)
    .onSuccess((list) => {
      if (list.length === 0) return <p className="text-xs text-muted-foreground">{m.artifacts_empty()}</p>
      const mine = list.filter((artifact) => artifact.threadId === threadId)
      const others = list.filter((artifact) => artifact.threadId !== threadId)
      return (
        <>
          <Section title={m.artifacts_this_thread()}>
            {mine.length === 0 ? (
              <p className="text-xs text-muted-foreground">{m.artifacts_this_thread_empty()}</p>
            ) : (
              <ArtifactRows threadId={threadId} artifacts={mine} />
            )}
          </Section>
          {others.length > 0 && (
            <Section title={m.artifacts_other_threads()}>
              <ArtifactRows threadId={threadId} artifacts={others} />
            </Section>
          )}
        </>
      )
    })
    .onError((error) => failed(errorMessage(error)))
    .orElse(() => failed(""))
}

function ArtifactRows({ threadId, artifacts }: { threadId: string; artifacts: ReadonlyArray<Artifact> }) {
  return (
    <ul className="-mx-2 flex flex-col">
      {artifacts.map((artifact) => (
        <ArtifactRow key={`${artifact.environmentId ?? ""}:${artifact.id}`} threadId={threadId} artifact={artifact} />
      ))}
    </ul>
  )
}

function ArtifactRow({ threadId, artifact }: { threadId: string; artifact: Artifact }) {
  const select = useArtifacts((state) => state.select)
  const navigate = useNavigate()
  const origin = useThreads((state) =>
    artifact.threadId === undefined || artifact.threadId === threadId ? undefined : state.byId[artifact.threadId],
  )
  const clouds = useClouds()
  const now = useNow()
  const updated = formatRelativeTime(artifact.updatedAt, now, getLocale())
  const remove = () =>
    callPromise("artifacts.delete", { id: artifact.id }, { environment: artifact.environmentId })
      .then(() => toast(m.artifacts_deleted({ title: artifact.title })))
      .catch((cause: unknown) =>
        toast.error(m.artifacts_delete_failed({ title: artifact.title, message: errorMessage(cause) })),
      )
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<li />}>
        <button
          type="button"
          onClick={() => select(threadId, artifact.id)}
          className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate text-sm">{artifact.title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {origin === undefined ? null : `${origin.title} · `}
            {artifact.environmentId === undefined
              ? updated
              : m.artifacts_updated_on({ time: updated, machine: environmentName(artifact.environmentId, clouds) })}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {origin !== undefined && (
          <DropdownMenuItem onClick={() => void navigate({ to: "/thread/$threadId", params: { threadId: origin.id } })}>
            <ArrowRightIcon aria-hidden />
            {m.artifacts_go_to_thread()}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem variant="destructive" onClick={() => void remove()}>
          <TrashIcon aria-hidden />
          {m.artifacts_delete()}
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
