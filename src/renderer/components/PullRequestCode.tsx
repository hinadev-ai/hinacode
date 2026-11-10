import { useAtomValue } from "@effect/atom-react"
import { useParams } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { create } from "zustand"
import type { DiffLineAnnotation } from "@pierre/diffs"
import { use, useId, useState, useTransition } from "react"
import type {
  GuideCategory,
  GuideFileNote,
  GuideLineNote,
  PullRequestComment,
  PullRequestFile,
  PullRequestGuideState,
  PullRequestStatus,
} from "../../shared/domain.ts"
import { useOpenThreadEnvironment } from "../lib/environments.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import {
  diffTooLarge,
  type GuideFile,
  groupFiles,
  noteAnnotations,
  type ResolvedGroup,
  resolveGuide,
} from "../../shared/pullRequestGuide.ts"
import { callPromise, type EnvironmentId, pullRequestDetailAtom, pullRequestFilesAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { loadPullRequestGuideAtom, usePullRequestGuides } from "../stores/pullRequestGuides.ts"
import { ShimmerText } from "./ShimmerText.tsx"
import { FileDiffRow, pullRequestFileMark } from "./FilePatch.tsx"
import {
  BookIcon,
  CodeIcon,
  CollapseIcon,
  DatabaseIcon,
  ExpandIcon,
  EyeIcon,
  FlaskIcon,
  FolderIcon,
  GuideIcon,
  HammerIcon,
  type IconComponent,
  ImageIcon,
  LayoutIcon,
  MoreIcon,
  PackageIcon,
  PipIcon,
  PlayIcon,
  PlugIcon,
  ShieldKeyholeIcon,
  SlidersIcon,
  TerminalIcon,
  ToolsIcon,
  TranslateIcon,
  WarningIcon,
} from "@hinacode/icons"
import { Markdown } from "./Markdown.tsx"
import { FilePreview, previewKind } from "./PullRequestFilePreview.tsx"
import {
  annotationSide,
  commentsOnLines,
  type LineSelection,
  lineSelection,
  PullRequestReviewContext,
  ReviewCommentForm,
  ReviewCommentThread,
} from "./PullRequestReview.tsx"
import { Button } from "./ui/button.tsx"
import { Checkbox } from "./ui/checkbox.tsx"
import { SkeletonList } from "./ui/skeleton.tsx"
import { LineCounts } from "./LineCounts.tsx"

const categoryIcon = {
  ui: LayoutIcon,
  api: PlugIcon,
  core: CodeIcon,
  data: DatabaseIcon,
  cli: TerminalIcon,
  security: ShieldKeyholeIcon,
  tests: FlaskIcon,
  docs: BookIcon,
  examples: PlayIcon,
  deps: PackageIcon,
  build: HammerIcon,
  scripts: ToolsIcon,
  config: SlidersIcon,
  i18n: TranslateIcon,
  assets: ImageIcon,
  other: MoreIcon,
} satisfies Record<GuideCategory, IconComponent>

const categoryLabel = {
  ui: m.guide_category_ui,
  api: m.guide_category_api,
  core: m.guide_category_core,
  data: m.guide_category_data,
  cli: m.guide_category_cli,
  security: m.guide_category_security,
  tests: m.guide_category_tests,
  docs: m.guide_category_docs,
  examples: m.guide_category_examples,
  deps: m.guide_category_deps,
  build: m.guide_category_build,
  scripts: m.guide_category_scripts,
  config: m.guide_category_config,
  i18n: m.guide_category_i18n,
  assets: m.guide_category_assets,
  other: m.guide_category_other,
} satisfies Record<GuideCategory, () => string>

const shortCommit = (head: string) => head.slice(0, 7)

const noteKey = (note: GuideFileNote | GuideLineNote) =>
  "line" in note ? `${note.side}:${note.line}:${note.text}` : note.text

type PullRequestCodeView = "files" | "guide"

export function PullRequestCode({ url, view }: { url: string; view: PullRequestCodeView }) {
  const environment = useOpenThreadEnvironment()
  const detail = useAtomValue(pullRequestDetailAtom(environment, url))

  return (
    <div className="flex flex-col gap-3">
      {AsyncResult.builder(detail)
        .onSuccess((pullRequest) =>
          diffTooLarge(pullRequest) ? (
            <p className="text-xs text-muted-foreground">{m.pr_code_too_large()}</p>
          ) : (
            <ChangedFiles
              environment={environment}
              url={url}
              head={pullRequest.head}
              baseRef={pullRequest.baseRef}
              status={pullRequest.status}
              comments={pullRequest.comments}
              view={view}
            />
          ),
        )
        .onError((error) => (
          <p role="alert" className="text-xs wrap-anywhere text-destructive">
            {m.pr_detail_failed({ message: errorMessage(error) })}
          </p>
        ))
        .orElse(() => (
          <SkeletonList label={m.pr_detail_loading()} rows={4} rowClassName="h-4" />
        ))}
    </div>
  )
}

interface ChangedFilesProps {
  readonly environment: EnvironmentId
  readonly url: string
  readonly head: string
  readonly baseRef: string
  readonly status: PullRequestStatus
  readonly comments: ReadonlyArray<PullRequestComment>
  readonly view: PullRequestCodeView
}

function ChangedFiles({ environment, url, head, baseRef, status, comments, view }: ChangedFilesProps) {
  const diff = useAtomValue(pullRequestFilesAtom(environment, url, head))

  return AsyncResult.builder(diff)
    .onSuccess((files) => {
      if (files.length === 0) return <p className="text-xs text-muted-foreground">{m.diff_empty()}</p>
      return (
        <>
          {view === "files" ? (
            <ReviewedFiles
              environment={environment}
              url={url}
              head={head}
              baseRef={baseRef}
              comments={comments}
              files={files}
            />
          ) : (
            <>
              <DiffSummary files={files} />
              <GuideView environment={environment} url={url} currentHead={head} status={status} files={files} />
            </>
          )}
        </>
      )
    })
    .onError((error) => (
      <p role="alert" className="text-xs wrap-anywhere text-destructive">
        {m.diff_failed({ message: errorMessage(error) })}
      </p>
    ))
    .orElse(() => <SkeletonList label={m.diff_loading()} rows={4} rowClassName="h-4" />)
}

const VIEWED_FILES_KEY = "hinacode.viewedPullRequestFiles"

type ViewedFiles = Readonly<Record<string, { readonly head: string; readonly paths: ReadonlyArray<string> }>>

const loadViewedFiles = (): ViewedFiles => {
  try {
    return JSON.parse(localStorage.getItem(VIEWED_FILES_KEY) ?? "{}") as ViewedFiles
  } catch {
    return {}
  }
}

export const useViewedFiles = create<{
  readonly byUrl: ViewedFiles
  readonly setViewed: (url: string, head: string, path: string, viewed: boolean) => void
}>()((set, get) => ({
  byUrl: loadViewedFiles(),
  setViewed: (url, head, path, viewed) => {
    const current = get().byUrl[url]
    const paths = (current?.head === head ? current.paths : []).filter((other) => other !== path)
    const byUrl = { ...get().byUrl, [url]: { head, paths: viewed ? [...paths, path] : paths } }
    localStorage.setItem(VIEWED_FILES_KEY, JSON.stringify(byUrl))
    set({ byUrl })
  },
}))

const NONE_VIEWED: ReadonlyArray<string> = []

export const useViewedPaths = (url: string, head: string) =>
  useViewedFiles((state) => {
    const entry = state.byUrl[url]
    return entry?.head === head ? entry.paths : NONE_VIEWED
  })

const directoryOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1)
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)

const byFolder = (files: ReadonlyArray<PullRequestFile>) => {
  const folders = new Map<string, Array<PullRequestFile>>()
  for (const file of files) folders.set(directoryOf(file.path), [...(folders.get(directoryOf(file.path)) ?? []), file])
  return [...folders]
}

function ReviewedFiles({
  environment,
  url,
  head,
  baseRef,
  comments,
  files,
}: {
  environment: EnvironmentId
  url: string
  head: string
  baseRef: string
  comments: ReadonlyArray<PullRequestComment>
  files: ReadonlyArray<PullRequestFile>
}) {
  const viewed = new Set(useViewedPaths(url, head))
  const setViewed = useViewedFiles((state) => state.setViewed)
  const { threadId } = useParams({ strict: false })
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [, startTransition] = useTransition()
  const added = files.reduce((sum, file) => sum + file.additions, 0)
  const removed = files.reduce((sum, file) => sum + file.deletions, 0)
  const viewedCount = files.filter((file) => viewed.has(file.path)).length
  const allOpen = files.length > 0 && files.every((file) => openPaths.has(file.path))

  const withOpen = (path: string, open: boolean) => {
    const next = new Set(openPaths)
    if (open) next.add(path)
    else next.delete(path)
    return next
  }

  const toggle = (path: string) => startTransition(() => setOpenPaths(withOpen(path, !openPaths.has(path))))

  const markViewed = (path: string, next: boolean) =>
    startTransition(() => {
      setViewed(url, head, path, next)
      if (next) setOpenPaths(withOpen(path, false))
    })

  return (
    <PullRequestReviewContext value={{ environment, url, head, baseRef, threadId, comments }}>
      <div className="@container flex flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
          <span>{m.pr_code_summary({ count: files.length })}</span>
          <span aria-hidden>·</span>
          <span>{m.pr_files_viewed({ viewed: viewedCount, total: files.length })}</span>
          <LineCounts added={added} removed={removed} />
          {threadId && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="ms-auto"
              aria-label={m.pr_open_in_window()}
              title={m.pr_open_in_window()}
              action={() => callPromise("windows.openPullRequest", { threadId, url })}
            >
              <PipIcon aria-hidden />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(!threadId && "ms-auto")}
            aria-label={allOpen ? m.diff_collapse_all() : m.diff_expand_all()}
            title={allOpen ? m.diff_collapse_all() : m.diff_expand_all()}
            action={() => setOpenPaths(allOpen ? new Set() : new Set(files.map((file) => file.path)))}
          >
            {allOpen ? <CollapseIcon aria-hidden /> : <ExpandIcon aria-hidden />}
          </Button>
        </div>
        <div className="flex flex-col gap-3">
          {byFolder(files).map(([folder, inFolder]) => (
            <section key={folder} aria-label={folder || "/"} className="flex flex-col gap-0.5">
              <h3 className="flex min-w-0 items-center gap-1.5 px-1.5 font-mono text-xs text-muted-foreground">
                <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate" title={folder || "/"}>
                  {folder || "/"}
                </span>
              </h3>
              <ul className="ms-3.5 flex flex-col gap-0.5 border-s ps-1.5">
                {inFolder.map((file) => (
                  <PullRequestFileRow
                    key={file.path}
                    entry={{ file, fileNotes: [], lineNotesInHunks: [], lineNotesOutsideHunks: [] }}
                    label={nameOf(file.path)}
                    review={{
                      open: openPaths.has(file.path),
                      onToggle: () => toggle(file.path),
                      viewed: viewed.has(file.path),
                      onViewedChange: (next) => markViewed(file.path, next),
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </PullRequestReviewContext>
  )
}

function DiffSummary({ files }: { files: ReadonlyArray<PullRequestFile> }) {
  const added = files.reduce((sum, file) => sum + file.additions, 0)
  const removed = files.reduce((sum, file) => sum + file.deletions, 0)
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="tabular-nums">{m.pr_code_summary({ count: files.length })}</span>
      <LineCounts added={added} removed={removed} />
    </p>
  )
}

interface FileReview {
  readonly open: boolean
  readonly onToggle: () => void
  readonly viewed: boolean
  readonly onViewedChange: (viewed: boolean) => void
}

type RowAnnotation =
  | { readonly kind: "notes"; readonly notes: ReadonlyArray<GuideLineNote> }
  | { readonly kind: "github"; readonly comments: ReadonlyArray<PullRequestComment> }
  | { readonly kind: "draft"; readonly selection: LineSelection }

export function PullRequestFileRow({
  entry,
  review,
  label,
  anchorId,
}: {
  entry: GuideFile
  review?: FileReview
  label?: string
  anchorId?: string
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const [draft, setDraft] = useState<LineSelection | null>(null)
  const kind = previewKind(entry.file.path)
  const [previewing, setPreviewing] = useState(kind !== null && entry.file.binary)
  const [, startTransition] = useTransition()
  const reviewing = use(PullRequestReviewContext)
  const open = review ? review.open : ownOpen
  const { file } = entry
  const notes = [...entry.fileNotes, ...entry.lineNotesOutsideHunks]
  const critical = [...notes, ...entry.lineNotesInHunks].some((note) => note.critical === true)
  const annotations: Array<DiffLineAnnotation<RowAnnotation>> = [
    ...noteAnnotations(entry.lineNotesInHunks).map(({ side, lineNumber, metadata }) => ({
      side,
      lineNumber,
      metadata: { kind: "notes" as const, notes: metadata },
    })),
    ...(reviewing ? commentsOnLines(reviewing.comments, file.path) : []).map(({ side, lineNumber, comments }) => ({
      side,
      lineNumber,
      metadata: { kind: "github" as const, comments },
    })),
    ...(draft
      ? [
          {
            side: annotationSide(draft.side),
            lineNumber: draft.endLine,
            metadata: { kind: "draft" as const, selection: draft },
          },
        ]
      : []),
  ]

  return (
    <FileDiffRow<RowAnnotation>
      path={label ?? file.path}
      anchorId={anchorId}
      title={file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`}
      mark={pullRequestFileMark[file.status]}
      added={file.additions}
      removed={file.deletions}
      patch={file.binary ? undefined : file.patch}
      open={open}
      onToggle={review ? review.onToggle : () => setOwnOpen(!ownOpen)}
      badge={critical && <CriticalMark />}
      muted={review?.viewed}
      preview={previewing && reviewing && kind && <FilePreview review={reviewing} file={file} kind={kind} />}
      actions={
        review && (
          <>
            {reviewing && kind && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-pressed={previewing}
                aria-label={previewing ? m.pr_file_show_diff() : m.pr_file_preview()}
                title={previewing ? m.pr_file_show_diff() : m.pr_file_preview()}
                action={() => {
                  setPreviewing(!previewing)
                  if (!review.open) review.onToggle()
                }}
              >
                {previewing ? <CodeIcon aria-hidden /> : <EyeIcon aria-hidden />}
              </Button>
            )}
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={review.viewed}
                onCheckedChange={(checked) => review.onViewedChange(checked === true)}
              />
              <span className="@max-md:sr-only">{m.pr_file_viewed()}</span>
            </label>
          </>
        )
      }
      notes={
        notes.length > 0 && (
          <ul className="flex flex-col gap-1 pl-6">
            {notes.map((note) => (
              <li key={noteKey(note)}>
                <NoteCard note={note} showLine />
              </li>
            ))}
          </ul>
        )
      }
      lineAnnotations={annotations}
      selectedLines={draft && { start: draft.startLine, end: draft.endLine, side: annotationSide(draft.side) }}
      onCommentLines={reviewing ? (range) => startTransition(() => setDraft(lineSelection(range))) : undefined}
      renderAnnotation={({ metadata }) => {
        if (metadata.kind === "github") return <ReviewCommentThread comments={metadata.comments} />
        if (metadata.kind === "draft")
          return (
            reviewing && (
              <ReviewCommentForm
                review={reviewing}
                file={file}
                selection={metadata.selection}
                onDone={() => startTransition(() => setDraft(null))}
              />
            )
          )
        return (
          <ul className="flex flex-col gap-1 px-2 py-1.5 font-sans">
            {metadata.notes.map((note) => (
              <li key={noteKey(note)}>
                <NoteCard note={note} />
              </li>
            ))}
          </ul>
        )
      }}
    />
  )
}

function CriticalMark({ className }: { className?: string }) {
  return (
    <span title={m.guide_critical()} className="flex shrink-0">
      <WarningIcon aria-hidden className={cn("size-3.5 text-attention", className)} />
      <span className="sr-only">{m.guide_critical()}</span>
    </span>
  )
}

function NoteCard({ note, showLine = false }: { note: GuideFileNote | GuideLineNote; showLine?: boolean }) {
  return (
    <div
      className={cn(
        "flex gap-2 rounded-md border px-2.5 py-1.5 text-xs",
        note.critical ? "border-attention/30 bg-attention/10" : "border-border bg-muted/40",
      )}
    >
      {note.critical ? (
        <CriticalMark className="mt-0.5" />
      ) : (
        <GuideIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        {showLine && "line" in note && (
          <p className="font-mono text-muted-foreground">{m.guide_line({ line: note.line })}</p>
        )}
        <Markdown text={note.text} className="prose-sm" />
      </div>
    </div>
  )
}

interface GuideViewProps {
  readonly environment: EnvironmentId
  readonly url: string
  readonly currentHead: string
  readonly status: PullRequestStatus
  readonly files: ReadonlyArray<PullRequestFile>
}

function GuideView({ environment, url, currentHead, status, files }: GuideViewProps) {
  const load = useAtomValue(loadPullRequestGuideAtom(environment, url))
  const state = usePullRequestGuides((guides) => guides.byUrl[url])

  if (!state) {
    return AsyncResult.builder(load)
      .onError((error) => (
        <p role="alert" className="text-xs wrap-anywhere text-destructive">
          {m.guide_failed({ message: errorMessage(error) })}
        </p>
      ))
      .orElse(() => <SkeletonList label={m.diff_loading()} rows={4} rowClassName="h-4" />)
  }

  const { guide } = state
  if (guide === null)
    return (
      <GuideJobNotice environment={environment} url={url} currentHead={currentHead} status={status} state={state} />
    )
  const { groups, others } = resolveGuide(guide, files)
  const other: ResolvedGroup = {
    key: "other",
    label: m.guide_other(),
    summary: m.guide_other_hint(),
    category: "other",
    containsCritical: false,
    files: others,
    children: [],
  }

  return (
    <div className="flex flex-col gap-4">
      {guide.head !== currentHead && (
        <GuideJobNotice environment={environment} url={url} currentHead={currentHead} status={status} state={state} />
      )}
      <Markdown text={guide.summary} className="prose-sm" />
      <ol className="flex flex-col divide-y divide-border">
        {groups.map((group) => (
          <li key={group.key} className="py-4 first:pt-0">
            <GuideGroupView group={group} />
          </li>
        ))}
        {others.length > 0 && (
          <li className="py-4 first:pt-0">
            <GuideGroupView group={other} />
          </li>
        )}
      </ol>
      <p className="text-xs text-muted-foreground">
        {m.guide_written_by({ model: guide.model, commit: shortCommit(guide.head) })}
      </p>
    </div>
  )
}

function GuideGroupView({ group }: { group: ResolvedGroup }) {
  const headingId = useId()
  const files = groupFiles(group)
  const Icon = categoryIcon[group.category]
  const category = categoryLabel[group.category]()

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <header className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span title={category} className="flex shrink-0">
            <Icon aria-hidden className="size-4 text-muted-foreground" />
            <span className="sr-only">{category}</span>
          </span>
          <h4 id={headingId} className="min-w-0 flex-1 text-sm font-medium text-pretty">
            {group.label}
          </h4>
          {group.containsCritical && <CriticalMark className="size-4" />}
        </div>
        <p className="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
          <span className="tabular-nums">{m.guide_group_files({ count: files.length })}</span>
          <LineCounts
            added={files.reduce((sum, entry) => sum + entry.file.additions, 0)}
            removed={files.reduce((sum, entry) => sum + entry.file.deletions, 0)}
          />
        </p>
      </header>
      {group.summary && <Markdown text={group.summary} className="prose-sm pl-6 text-xs text-muted-foreground" />}
      {group.files.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {group.files.map((entry) => (
            <PullRequestFileRow key={entry.file.path} entry={entry} />
          ))}
        </ul>
      )}
      {group.children.length > 0 && (
        <ol className="ml-2 flex flex-col gap-4 border-l border-border pl-3">
          {group.children.map((child) => (
            <li key={child.key}>
              <GuideGroupView group={child} />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

interface GuideJobNoticeProps {
  readonly environment: EnvironmentId
  readonly url: string
  readonly currentHead: string
  readonly status: PullRequestStatus
  readonly state: PullRequestGuideState
}

function GuideJobNotice({ environment, url, currentHead, status, state }: GuideJobNoticeProps) {
  const job = state.job?.head === currentHead ? state.job : null
  const outdated = state.guide !== null && state.guide.head !== currentHead

  if (job?.status === "failed") {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5"
      >
        {outdated && state.guide && (
          <p className="text-xs">{m.guide_outdated({ commit: shortCommit(state.guide.head) })}</p>
        )}
        <p className="text-xs wrap-anywhere">{m.guide_failed({ message: job.message })}</p>
        <RetryButton environment={environment} url={url} />
      </div>
    )
  }
  if (outdated && state.guide) {
    return (
      <div className="flex flex-col gap-1 rounded-md border border-attention/30 bg-attention/10 p-2.5 text-xs">
        <p>{m.guide_outdated({ commit: shortCommit(state.guide.head) })}</p>
        {job?.status === "running" && <ShimmerText text={m.guide_outdated_writing()} />}
      </div>
    )
  }
  if (job?.status === "running") {
    return (
      <div className="flex flex-col gap-2">
        <ShimmerText className="text-xs" text={m.guide_writing({ commit: shortCommit(currentHead) })} />
        <p className="text-xs text-muted-foreground">{m.guide_writing_hint()}</p>
      </div>
    )
  }
  return (
    <p className="text-xs text-muted-foreground">
      {status === "merged" || status === "closed" ? m.guide_closed() : m.guide_not_started()}
    </p>
  )
}

function RetryButton({ environment, url }: { environment: EnvironmentId; url: string }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const retry = () =>
    startTransition(async () => {
      try {
        setError(null)
        await callPromise("pullRequestGuides.retry", { url }, { environment })
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <>
      <Button variant="outline" size="xs" disabled={pending} onClick={retry}>
        {m.common_retry()}
      </Button>
      {error && <p className="text-xs wrap-anywhere text-destructive">{error}</p>}
    </>
  )
}
