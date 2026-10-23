import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useId, useState, useTransition } from "react"
import type { IconType } from "react-icons"
import {
  RiBookOpenLine,
  RiBox3Line,
  RiCodeSSlashLine,
  RiDatabase2Line,
  RiEqualizerLine,
  RiErrorWarningLine,
  RiFlaskLine,
  RiHammerLine,
  RiImageLine,
  RiLayoutMasonryLine,
  RiMoreLine,
  RiPlayCircleLine,
  RiPlugLine,
  RiShieldKeyholeLine,
  RiSparkling2Line,
  RiTerminalBoxLine,
  RiToolsLine,
  RiTranslate2,
} from "react-icons/ri"
import type {
  GuideCategory,
  GuideFileNote,
  GuideLineNote,
  PullRequestFile,
  PullRequestGuideState,
  PullRequestStatus,
} from "../../shared/domain.ts"
import { useOpenThreadEnvironment } from "../lib/environments.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import {
  type GuideFile,
  groupFiles,
  noteAnnotations,
  type ResolvedGroup,
  resolveGuide,
} from "../lib/pullRequestGuide.ts"
import { callPromise, type EnvironmentId, pullRequestDetailAtom, pullRequestFilesAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { loadPullRequestGuideAtom, usePullRequestGuides } from "../stores/pullRequestGuides.ts"
import { type PullRequestCodeView, useUi } from "../stores/ui.ts"
import { FileDiffRow, pullRequestFileMark } from "./FilePatch.tsx"
import { Markdown } from "./Markdown.tsx"
import { Button } from "./ui/button.tsx"
import { SkeletonList } from "./ui/skeleton.tsx"
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx"

const categoryIcon = {
  ui: RiLayoutMasonryLine,
  api: RiPlugLine,
  core: RiCodeSSlashLine,
  data: RiDatabase2Line,
  cli: RiTerminalBoxLine,
  security: RiShieldKeyholeLine,
  tests: RiFlaskLine,
  docs: RiBookOpenLine,
  examples: RiPlayCircleLine,
  deps: RiBox3Line,
  build: RiHammerLine,
  scripts: RiToolsLine,
  config: RiEqualizerLine,
  i18n: RiTranslate2,
  assets: RiImageLine,
  other: RiMoreLine,
} satisfies Record<GuideCategory, IconType>

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

export function PullRequestCode({ url }: { url: string }) {
  const environment = useOpenThreadEnvironment()
  const detail = useAtomValue(pullRequestDetailAtom(environment, url))
  const view = useUi((state) => state.pullRequestCodeView)
  const setView = useUi((state) => state.setPullRequestCodeView)

  useEffect(() => {
    useUi.getState().setSidePanelWide(true)
    return () => useUi.getState().setSidePanelWide(false)
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <Tabs value={view} onValueChange={(value: PullRequestCodeView) => setView(value)}>
        <TabsList aria-label={m.pr_code_view_label()} className="w-full">
          <TabsTrigger value="files">{m.pr_code_view_files()}</TabsTrigger>
          <TabsTrigger value="guide">
            <RiSparkling2Line aria-hidden />
            {m.pr_code_view_guide()}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {AsyncResult.builder(detail)
        .onSuccess((pullRequest) => (
          <ChangedFiles
            environment={environment}
            url={url}
            head={pullRequest.head}
            status={pullRequest.status}
            view={view}
          />
        ))
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
  readonly status: PullRequestStatus
  readonly view: PullRequestCodeView
}

function ChangedFiles({ environment, url, head, status, view }: ChangedFilesProps) {
  const diff = useAtomValue(pullRequestFilesAtom(environment, url, head))

  return AsyncResult.builder(diff)
    .onSuccess((files) => {
      if (files.length === 0) return <p className="text-xs text-muted-foreground">{m.diff_empty()}</p>
      return (
        <>
          <DiffSummary files={files} />
          {view === "files" ? (
            <ul className="flex flex-col gap-0.5">
              {files.map((file) => (
                <PullRequestFileRow
                  key={file.path}
                  entry={{ file, fileNotes: [], lineNotesInHunks: [], lineNotesOutsideHunks: [] }}
                />
              ))}
            </ul>
          ) : (
            <GuideView environment={environment} url={url} currentHead={head} status={status} files={files} />
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

function DiffSummary({ files }: { files: ReadonlyArray<PullRequestFile> }) {
  const added = files.reduce((sum, file) => sum + file.additions, 0)
  const removed = files.reduce((sum, file) => sum + file.deletions, 0)
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{m.pr_code_summary({ count: files.length })}</span>
      <LineCounts added={added} removed={removed} />
    </p>
  )
}

function LineCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono tabular-nums" aria-label={m.diff_line_counts({ added, removed })}>
      <span aria-hidden className="text-vcs-added">
        +{added}
      </span>{" "}
      <span aria-hidden className="text-destructive">
        −{removed}
      </span>
    </span>
  )
}

function PullRequestFileRow({ entry }: { entry: GuideFile }) {
  const [open, setOpen] = useState(false)
  const { file } = entry
  const notes = [...entry.fileNotes, ...entry.lineNotesOutsideHunks]
  const critical = [...notes, ...entry.lineNotesInHunks].some((note) => note.critical === true)

  return (
    <FileDiffRow<ReadonlyArray<GuideLineNote>>
      path={file.path}
      title={file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`}
      mark={pullRequestFileMark[file.status]}
      added={file.additions}
      removed={file.deletions}
      patch={file.binary ? undefined : file.patch}
      open={open}
      onToggle={() => setOpen(!open)}
      badge={critical && <CriticalMark />}
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
      lineAnnotations={noteAnnotations(entry.lineNotesInHunks)}
      renderAnnotation={({ metadata }) => (
        <ul className="flex flex-col gap-1 px-2 py-1.5 font-sans">
          {metadata.map((note) => (
            <li key={noteKey(note)}>
              <NoteCard note={note} />
            </li>
          ))}
        </ul>
      )}
    />
  )
}

function CriticalMark({ className }: { className?: string }) {
  return (
    <span title={m.guide_critical()} className="flex shrink-0">
      <RiErrorWarningLine aria-hidden className={cn("size-3.5 text-attention", className)} />
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
        <RiSparkling2Line aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        {showLine && "line" in note && (
          <p className="font-mono text-muted-foreground">{m.guide_line({ line: note.line })}</p>
        )}
        <Markdown text={note.text} />
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
      <div className="text-sm">
        <Markdown text={guide.summary} />
      </div>
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
          <span>{m.guide_group_files({ count: files.length })}</span>
          <LineCounts
            added={files.reduce((sum, entry) => sum + entry.file.additions, 0)}
            removed={files.reduce((sum, entry) => sum + entry.file.deletions, 0)}
          />
        </p>
      </header>
      {group.summary && (
        <div className="pl-6 text-xs text-muted-foreground">
          <Markdown text={group.summary} />
        </div>
      )}
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
        {job?.status === "running" && <p className="text-shimmer">{m.guide_outdated_writing()}</p>}
      </div>
    )
  }
  if (job?.status === "running") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-shimmer">{m.guide_writing({ commit: shortCommit(currentHead) })}</p>
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
