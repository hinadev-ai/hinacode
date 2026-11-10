import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { Effect } from "effect"
import { AsyncResult, AtomRegistry } from "effect/reactivity"
import {
  type KeyboardEvent,
  lazy,
  useContext,
  useEffect,
  useId,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react"
import { RiDownload2Line } from "react-icons/ri"
import { toast } from "sonner"
import { type Artifact, type ArtifactExportRequest, isDocument } from "../../../shared/artifact.ts"
import { addArtifactProblem, artifactProblemMessage } from "../../../shared/artifactProblems.ts"
import { artifactUrl } from "../../../shared/channels.ts"
import type { Thread } from "../../../shared/domain.ts"
import { artifactMention } from "../../../shared/mentions.ts"
import { environmentName, useClouds, useThreadEnvironment } from "../../lib/environments.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { formatRelativeTime } from "../../lib/relativeTime.ts"
import { useArtifactTheme } from "../../lib/artifactTheme.ts"
import { artifactsAtom, callPromise } from "../../lib/rpc.ts"
import { useNow } from "../../lib/useNow.ts"
import { m } from "../../paraglide/messages.js"
import { getLocale } from "../../paraglide/runtime.js"
import { useArtifacts } from "../../stores/artifacts.ts"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  AtIcon,
  CopyIcon,
  FileTextIcon,
  FlowIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
} from "@hinacode/icons"
import { useDrafts } from "../../stores/drafts.ts"
import { useThreads } from "../../stores/threads.ts"
import { Button } from "../ui/button.tsx"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../ui/context-menu.tsx"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.tsx"
import { SkeletonList } from "../ui/skeleton.tsx"
import { liveDocument, liveDocumentKey } from "../documentEditor/liveDocuments.ts"
import { Section, ViewBody } from "./Section.tsx"
import { ArtifactKindIcon } from "./ArtifactKindIcon.tsx"
import { resourceUrl, servedSandbox } from "../../lib/resourceUrl.ts"
import { inBrowser } from "../../lib/runtime.ts"

const DocumentView = lazy(() =>
  import("../documentEditor/DocumentView.tsx").then((module) => ({ default: module.DocumentView })),
)

const WhiteboardView = lazy(() =>
  import("../whiteboard/WhiteboardView.tsx").then((module) => ({ default: module.WhiteboardView })),
)

const noArtifacts: ReadonlyArray<Artifact> = []

function useSelectedArtifact(threadId: string) {
  const id = useArtifacts((state) => state.selected[threadId])
  const artifacts = AsyncResult.getOrElse(useAtomValue(artifactsAtom), () => noArtifacts)
  return artifacts.find((artifact) => artifact.id === id)
}

const mentionInThread = (threadId: string, artifact: Artifact) => {
  useDrafts.getState().appendText(threadId, artifactMention(artifact.id))
  toast(m.artifacts_mentioned({ title: `@${artifact.title}` }))
}

const copyMention = (artifact: Artifact) =>
  navigator.clipboard.writeText(artifactMention(artifact.id)).then(() => toast(m.common_copied()))

const useReadableByAgent = (threadId: string, artifact: Artifact | undefined) =>
  (artifact?.environmentId ?? null) === useThreadEnvironment(threadId)

export function ArtifactsHeader({ thread }: { thread: Thread }) {
  const selected = useSelectedArtifact(thread.id)
  const select = useArtifacts((state) => state.select)
  const readable = useReadableByAgent(thread.id, selected)
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
      <ArtifactTitle key={`${selected.environmentId ?? ""}:${selected.id}`} artifact={selected} />
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {m.artifacts_version({ version: selected.version })}
      </span>
      <span className="flex-1" />
      {readable && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.artifacts_mention()}
          title={m.artifacts_mention()}
          action={() => mentionInThread(thread.id, selected)}
        >
          <AtIcon aria-hidden />
        </Button>
      )}
      {!inBrowser() && exportable(selected) && <ExportMenu artifact={selected} />}
    </div>
  )
}

const refreshedArtifacts = (registry: AtomRegistry.AtomRegistry) => {
  registry.refresh(artifactsAtom)
  return Effect.runPromise(Effect.ignore(AtomRegistry.getResult(registry, artifactsAtom, { suspendOnWaiting: true })))
}

const focusOnMount = (element: HTMLElement | null) => element?.focus()

function ArtifactTitle({ artifact }: { artifact: Artifact }) {
  const registry = useContext(RegistryContext)
  const [editing, setEditing] = useState(false)
  const [refocus, setRefocus] = useState(false)
  const [renaming, startRenaming] = useTransition()
  const [title, showTitle] = useOptimistic(artifact.title)
  const hintId = useId()

  const finish = (next: { readonly title: string; readonly keyboard: boolean } | null) =>
    startRenaming(async () => {
      setEditing(false)
      setRefocus(next?.keyboard ?? true)
      const trimmed = next?.title.trim() ?? ""
      if (trimmed === "" || trimmed === artifact.title) return
      showTitle(trimmed)
      try {
        await callPromise(
          "artifacts.rename",
          { id: artifact.id, title: trimmed },
          { environment: artifact.environmentId },
        )
        await refreshedArtifacts(registry)
      } catch (cause) {
        toast.error(m.artifacts_rename_failed({ message: errorMessage(cause) }))
      }
    })

  if (editing && !renaming) return <TitleInput title={title} onDone={finish} />
  return (
    <h2 className="min-w-0">
      <button
        ref={refocus ? focusOnMount : undefined}
        type="button"
        title={m.artifacts_rename()}
        aria-describedby={hintId}
        aria-disabled={renaming || undefined}
        onClick={() => {
          if (!renaming) startRenaming(() => setEditing(true))
        }}
        className="block max-w-full cursor-text truncate rounded-md px-1.5 py-0.5 text-sm font-medium text-artifact-title outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:cursor-default aria-disabled:hover:bg-transparent"
      >
        {title}
      </button>
      <span id={hintId} hidden>
        {m.artifacts_rename()}
      </span>
    </h2>
  )
}

const selectOnMount = (input: HTMLInputElement | null) => input?.select()

function TitleInput({
  title,
  onDone,
}: {
  title: string
  onDone: (next: { readonly title: string; readonly keyboard: boolean } | null) => void
}) {
  const [draft, setDraft] = useState(title)
  const byKeyboard = useRef(false)
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Enter") {
      event.preventDefault()
      byKeyboard.current = true
      event.currentTarget.blur()
    }
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onDone(null)
    }
  }
  return (
    <input
      ref={selectOnMount}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() =>
        onDone(
          draft === title
            ? { title: "", keyboard: byKeyboard.current }
            : { title: draft, keyboard: byKeyboard.current },
        )
      }
      aria-label={m.artifacts_rename_label({ title })}
      className="field-sizing-content h-6 max-w-full min-w-24 rounded-md border border-input bg-transparent px-1.5 text-sm font-medium text-artifact-title outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    />
  )
}

const exportable = (artifact: Artifact) => artifact.kind !== "whiteboard"

const exportArtifact = (request: ArtifactExportRequest) =>
  callPromise("artifacts.export", request)
    .then((path) => {
      if (path !== null) toast(m.artifacts_exported({ path }))
    })
    .catch((cause: unknown) => toast.error(m.artifacts_export_failed({ message: errorMessage(cause) })))

function ExportMenu({ artifact }: { artifact: Artifact }) {
  const theme = useArtifactTheme()
  const save = (format: "html" | "pdf") =>
    exportArtifact({ format, id: artifact.id, entry: artifact.entry, title: artifact.title, theme })
  const saveDocument = async (format: "document-pdf" | "document-markdown") => {
    const open = liveDocument(liveDocumentKey(artifact.environmentId, artifact.id))
    if (open === undefined) return toast.error(m.documents_export_not_ready())
    const body = format === "document-pdf" ? await open.html() : open.markdown()
    return exportArtifact({ format, title: artifact.title, theme, body })
  }
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
        {isDocument(artifact) ? (
          <>
            <DropdownMenuItem onClick={() => void saveDocument("document-markdown")}>
              {m.artifacts_export_markdown()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void saveDocument("document-pdf")}>
              {m.artifacts_export_pdf()}
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onClick={() => void save("html")}>{m.artifacts_export_html()}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void save("pdf")}>{m.artifacts_export_pdf()}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ArtifactsView({ thread }: { thread: Thread }) {
  const selected = useSelectedArtifact(thread.id)
  const theme = useArtifactTheme()
  if (selected?.kind === "whiteboard") {
    return (
      <WhiteboardView key={`${selected.environmentId ?? ""}:${selected.id}`} threadId={thread.id} artifact={selected} />
    )
  }
  if (selected !== undefined && isDocument(selected)) {
    return (
      <DocumentView key={`${selected.environmentId ?? ""}:${selected.id}`} threadId={thread.id} artifact={selected} />
    )
  }
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
      if (message !== undefined) setProblems((current) => addArtifactProblem(current, message))
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
        src={resourceUrl(
          `${artifactUrl(artifact.id, artifact.entry)}?v=${artifact.version}&theme=${encodeURIComponent(theme)}`,
        )}
        title={artifact.title}
        sandbox={servedSandbox()}
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
    .onSuccess((list) => {
      const mine = list.filter((artifact) => artifact.threadId === threadId)
      const others = list.filter((artifact) => artifact.threadId !== threadId)
      return (
        <>
          <Section title={m.artifacts_this_thread()} action={<NewArtifactMenu threadId={threadId} />}>
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

function NewArtifactMenu({ threadId }: { threadId: string }) {
  const registry = useContext(RegistryContext)
  const select = useArtifacts((state) => state.select)
  const create = async (created: Promise<Artifact>, failed: (input: { message: string }) => string) => {
    try {
      const artifact = await created
      await refreshedArtifacts(registry)
      select(threadId, artifact.id)
    } catch (cause) {
      toast.error(failed({ message: errorMessage(cause) }))
    }
  }
  const createDocument = () =>
    create(
      callPromise("artifacts.createDocument", { threadId, title: m.documents_untitled() }),
      m.documents_create_failed,
    )
  const createWhiteboard = () =>
    create(
      callPromise("artifacts.createWhiteboard", { threadId, title: m.whiteboard_untitled() }),
      m.whiteboard_create_failed,
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="xs" />}>
        <PlusIcon aria-hidden />
        {m.artifacts_new()}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void createDocument()}>
          <FileTextIcon aria-hidden />
          {m.artifacts_new_document()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void createWhiteboard()}>
          <FlowIcon aria-hidden />
          {m.artifacts_new_whiteboard()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
  const readable = useReadableByAgent(threadId, artifact)
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
          className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArtifactKindIcon artifact={artifact} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm text-artifact-title">{artifact.title}</span>
            <span className="truncate text-xs text-muted-foreground">
              {origin === undefined ? null : `${origin.title} · `}
              {artifact.environmentId === undefined
                ? updated
                : m.artifacts_updated_on({ time: updated, machine: environmentName(artifact.environmentId, clouds) })}
            </span>
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {readable && (
          <DropdownMenuItem onClick={() => mentionInThread(threadId, artifact)}>
            <AtIcon aria-hidden />
            {m.artifacts_mention()}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => void copyMention(artifact)}>
          <CopyIcon aria-hidden />
          {m.artifacts_copy_mention()}
        </DropdownMenuItem>
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
