import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef, useState } from "react"
import { RiDownload2Line } from "react-icons/ri"
import { toast } from "sonner"
import type { Artifact } from "../../../shared/artifact.ts"
import { artifactProblemMessage } from "../../../shared/artifactProblems.ts"
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
import { useDrafts } from "../../stores/drafts.ts"
import { ArrowLeftIcon } from "../icons/ArrowLeftIcon.tsx"
import { TrashIcon } from "../icons/TrashIcon.tsx"
import { WarningIcon } from "../icons/WarningIcon.tsx"
import { Button } from "../ui/button.tsx"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../ui/context-menu.tsx"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.tsx"
import { SkeletonList } from "../ui/skeleton.tsx"
import { ViewBody } from "./Section.tsx"

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
      <h2 className="min-w-0 truncate text-sm font-medium">{selected.title}</h2>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {m.artifacts_version({ version: selected.version })}
      </span>
      <span className="flex-1" />
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
      <ArtifactFrame
        key={`${selected.id}:${selected.version}:${theme}`}
        threadId={thread.id}
        artifact={selected}
        theme={theme}
      />
    )
  }
  return (
    <ViewBody>
      <ArtifactList threadId={thread.id} />
    </ViewBody>
  )
}

function ArtifactFrame({ threadId, artifact, theme }: { threadId: string; artifact: Artifact; theme: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [problems, setProblems] = useState<ReadonlyArray<string>>([])
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source === null || event.source !== frame.current?.contentWindow) return
      const message = artifactProblemMessage(event.data)
      if (message !== undefined) setProblems((current) => (current.includes(message) ? current : [...current, message]))
    }
    window.addEventListener("message", listener)
    return () => window.removeEventListener("message", listener)
  }, [])
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {!loaded && (
        <p className="absolute top-4 left-4 animate-reveal text-xs text-muted-foreground">
          {m.artifacts_page_loading()}
        </p>
      )}
      <iframe
        ref={frame}
        src={`${artifactUrl(artifact.id, artifact.entry)}?v=${artifact.version}&theme=${encodeURIComponent(theme)}`}
        title={artifact.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        className="min-h-0 flex-1 border-0 bg-background"
      />
      {problems.length > 0 && <ArtifactProblems threadId={threadId} artifact={artifact} problems={problems} />}
    </div>
  )
}

function ArtifactProblems({
  threadId,
  artifact,
  problems,
}: {
  threadId: string
  artifact: Artifact
  problems: ReadonlyArray<string>
}) {
  const draft = useDrafts((state) => state.byThreadId[threadId]?.text ?? "")
  const setText = useDrafts((state) => state.setText)
  const askToFix = () => {
    const prompt = m.artifacts_fix_prompt({
      title: artifact.title,
      id: artifact.id,
      problems: problems.map((problem) => `- ${problem}`).join("\n"),
    })
    setText(threadId, draft.trim() === "" ? prompt : `${draft.trimEnd()}\n\n${prompt}`)
  }
  return (
    <section
      aria-label={m.artifacts_problems({ count: problems.length })}
      className="flex max-h-40 shrink-0 flex-col gap-2 border-t border-border p-3"
    >
      <div className="flex items-center gap-2">
        <WarningIcon aria-hidden className="size-4 shrink-0 text-destructive" />
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium">
          {m.artifacts_problems({ count: problems.length })}
        </h3>
        <Button variant="outline" size="xs" action={askToFix}>
          {m.artifacts_ask_to_fix()}
        </Button>
      </div>
      <ul className="min-h-0 overflow-y-auto font-mono text-xs text-muted-foreground">
        {problems.map((problem) => (
          <li key={problem} className="wrap-anywhere">
            {problem}
          </li>
        ))}
      </ul>
    </section>
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
    .onSuccess((list) =>
      list.length === 0 ? (
        <p className="text-xs text-muted-foreground">{m.artifacts_empty()}</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {list.map((artifact) => (
            <ArtifactRow
              key={`${artifact.environmentId ?? ""}:${artifact.id}`}
              threadId={threadId}
              artifact={artifact}
            />
          ))}
        </ul>
      ),
    )
    .onError((error) => failed(errorMessage(error)))
    .orElse(() => failed(""))
}

function ArtifactRow({ threadId, artifact }: { threadId: string; artifact: Artifact }) {
  const select = useArtifacts((state) => state.select)
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
            {artifact.environmentId === undefined
              ? updated
              : m.artifacts_updated_on({ time: updated, machine: environmentName(artifact.environmentId, clouds) })}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <DropdownMenuItem variant="destructive" onClick={() => void remove()}>
          <TrashIcon aria-hidden />
          {m.artifacts_delete()}
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
