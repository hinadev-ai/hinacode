import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { detectPlatform } from "@tanstack/react-hotkeys"
import { useParams, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useState, useTransition } from "react"
import type { PullRequestDetail, PullRequestFile } from "../../shared/domain.ts"
import { useThreadEnvironment } from "../lib/environments.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { type FileTreeFolder, fileTree } from "../lib/fileTree.ts"
import { type EnvironmentId, pullRequestDetailAtom, pullRequestFilesAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { pullRequestName } from "../lib/pullRequestRefs.ts"
import { m } from "../paraglide/messages.js"
import { inBrowser } from "../lib/runtime.ts"
import { DiffStyleContext, type DiffStyle } from "./FilePatch.tsx"
import { PullRequestFileRow } from "./PullRequestCode.tsx"
import { useViewedFiles, useViewedPaths } from "../stores/viewedFiles.ts"
import { PullRequestReviewContext } from "./PullRequestReview.tsx"
import { pullRequestStatusLabel, StatusIcon, statusIndicator } from "./ThreadPullRequests.tsx"
import { CheckIcon, ChevronRightIcon, FileIcon, FolderIcon, SearchIcon } from "@hinacode/icons"
import { Button, buttonVariants } from "./ui/button.tsx"
import { Input } from "./ui/input.tsx"
import { SkeletonList } from "./ui/skeleton.tsx"
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx"

const besideTrafficLights = () => detectPlatform() === "mac" && !inBrowser()

export function PullRequestWindow() {
  const { threadId } = useParams({ strict: false })
  const { url = "" } = useSearch({ strict: false }) as { url?: string }
  const environment = useThreadEnvironment(threadId)
  const detailAtom = pullRequestDetailAtom(environment, url)
  const detail = useAtomValue(detailAtom)
  const retry = useAtomRefresh(detailAtom)
  const pending = <h1 className="min-w-0 truncate font-medium">{pullRequestName(url)}</h1>

  return AsyncResult.builder(detail)
    .onSuccess((pullRequest) => (
      <FilesChanged threadId={threadId} pullRequest={pullRequest} environment={environment} />
    ))
    .onError((error) => (
      <WindowFrame header={pending}>
        <LoadFailure title={m.pr_detail_failed_title()} message={errorMessage(error)} href={url} onRetry={retry} />
      </WindowFrame>
    ))
    .orElse(() => (
      <WindowFrame header={pending}>
        <div className="p-6">
          <SkeletonList label={m.pr_detail_loading()} rows={5} rowClassName="h-5" />
        </div>
      </WindowFrame>
    ))
}

function WindowFrame({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="relative flex h-dvh flex-col overflow-clip bg-background text-foreground">
      <header
        className={cn(
          "flex h-titlebar shrink-0 items-center gap-2.5 border-b pe-3 text-sm select-none window-drag",
          besideTrafficLights() ? "ps-22" : "ps-4",
        )}
      >
        {header}
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  )
}

function LoadFailure({
  title,
  message,
  href,
  onRetry,
}: {
  title: string
  message: string
  href: string
  onRetry: () => void
}) {
  return (
    <div role="alert" className="mx-auto mt-16 flex w-full max-w-md flex-col gap-3 px-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-pretty wrap-anywhere text-muted-foreground">{message}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" action={onRetry}>
          {m.common_retry()}
        </Button>
        <a href={href} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          {m.pr_open_on_github()}
        </a>
      </div>
    </div>
  )
}

const anchorOf = (index: number) => `changed-file-${index}`

function FilesChanged({
  threadId,
  pullRequest,
  environment,
}: {
  threadId: string | undefined
  pullRequest: PullRequestDetail
  environment: EnvironmentId
}) {
  const filesAtom = pullRequestFilesAtom(environment, pullRequest.url, pullRequest.head)
  const files = useAtomValue(filesAtom)
  const retry = useAtomRefresh(filesAtom)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("split")

  return (
    <WindowFrame
      header={
        <>
          <title>{`#${pullRequest.number} ${pullRequest.title}`}</title>
          <span
            title={pullRequestStatusLabel[pullRequest.status]()}
            className={cn("flex shrink-0", statusIndicator[pullRequest.status].className)}
          >
            <StatusIcon status={pullRequest.status} />
          </span>
          <h1 className="min-w-0 truncate font-medium">{pullRequest.title}</h1>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">#{pullRequest.number}</span>
          <span className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground md:block">
            {m.pr_branches_into({ base: pullRequest.baseRef, head: pullRequest.headRef })}
          </span>
          <Tabs value={diffStyle} changeAction={(value: DiffStyle) => setDiffStyle(value)} className="ms-auto">
            <TabsList aria-label={m.diff_style_label()} className="group-data-horizontal/tabs:h-7">
              <TabsTrigger value="unified" className="px-2 text-xs">
                {m.diff_unified()}
              </TabsTrigger>
              <TabsTrigger value="split" className="px-2 text-xs">
                {m.diff_split()}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </>
      }
    >
      {AsyncResult.builder(files)
        .onSuccess((loaded) => (
          <DiffStyleContext value={diffStyle}>
            <PullRequestReviewContext
              value={{
                environment,
                url: pullRequest.url,
                head: pullRequest.head,
                baseRef: pullRequest.baseRef,
                threadId,
                comments: pullRequest.comments,
              }}
            >
              <ReviewWorkspace pullRequest={pullRequest} files={loaded} />
            </PullRequestReviewContext>
          </DiffStyleContext>
        ))
        .onError((error) => (
          <LoadFailure
            title={m.diff_failed_title()}
            message={errorMessage(error)}
            href={`${pullRequest.url}/files`}
            onRetry={retry}
          />
        ))
        .orElse(() => (
          <div className="p-6">
            <SkeletonList label={m.diff_loading()} rows={5} rowClassName="h-5" />
          </div>
        ))}
    </WindowFrame>
  )
}

function ReviewWorkspace({
  pullRequest,
  files,
}: {
  pullRequest: PullRequestDetail
  files: ReadonlyArray<PullRequestFile>
}) {
  const { url, head } = pullRequest
  const viewed = new Set(useViewedPaths(url, head))
  const setViewed = useViewedFiles((state) => state.setViewed)
  const [filter, setFilter] = useState("")
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(
    () => new Set(files.filter((file) => !viewed.has(file.path)).map((file) => file.path)),
  )
  const [, startTransition] = useTransition()
  const query = filter.trim().toLowerCase()
  const shown = query === "" ? files : files.filter((file) => file.path.toLowerCase().includes(query))
  const indexOf = new Map(files.map((file, index) => [file.path, index]))
  const viewedCount = files.filter((file) => viewed.has(file.path)).length

  const setOpen = (path: string, open: boolean) => {
    const next = new Set(openPaths)
    if (open) next.add(path)
    else next.delete(path)
    setOpenPaths(next)
  }

  const reveal = (path: string) =>
    startTransition(() => {
      setOpen(path, true)
      document.getElementById(anchorOf(indexOf.get(path) ?? 0))?.scrollIntoView({ block: "start" })
    })

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)]">
      <aside aria-label={m.pr_files_filter()} className="flex min-h-0 flex-col gap-3 border-e p-3">
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute inset-s-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={m.pr_files_filter()}
            aria-label={m.pr_files_filter()}
            className="h-8 ps-8 text-xs"
          />
        </div>
        <p className="px-1 text-xs text-muted-foreground tabular-nums">
          {m.pr_files_viewed({ viewed: viewedCount, total: files.length })}
        </p>
        <nav className="-mx-1 min-h-0 flex-1 scrollbar-gutter-stable overflow-auto">
          <FileTreeFolderView folder={fileTree(shown)} viewed={viewed} onReveal={reveal} depth={0} />
        </nav>
      </aside>
      <div className="min-h-0 scrollbar-gutter-stable overflow-auto p-4">
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.pr_files_none_match()}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {shown.map((file) => (
              <PullRequestFileRow
                key={file.path}
                anchorId={anchorOf(indexOf.get(file.path) ?? 0)}
                entry={{ file, fileNotes: [], lineNotesInHunks: [], lineNotesOutsideHunks: [] }}
                review={{
                  open: openPaths.has(file.path),
                  onToggle: () => startTransition(() => setOpen(file.path, !openPaths.has(file.path))),
                  viewed: viewed.has(file.path),
                  onViewedChange: (next) =>
                    startTransition(() => {
                      setViewed(url, head, file.path, next)
                      if (next) setOpen(file.path, false)
                    }),
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function FileTreeFolderView({
  folder,
  viewed,
  onReveal,
  depth,
}: {
  folder: FileTreeFolder<PullRequestFile>
  viewed: ReadonlySet<string>
  onReveal: (path: string) => void
  depth: number
}) {
  return (
    <ul className="flex flex-col">
      {folder.folders.map((child) => (
        <FolderItem key={child.path} folder={child} viewed={viewed} onReveal={onReveal} depth={depth} />
      ))}
      {folder.files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            title={file.path}
            onClick={() => onReveal(file.path)}
            style={{ paddingInlineStart: `${depth * 0.75 + 1.5}rem` }}
            className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pe-1.5 text-start text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={cn("min-w-0 flex-1 truncate", viewed.has(file.path) && "text-muted-foreground")}>
              {file.path.slice(file.path.lastIndexOf("/") + 1)}
            </span>
            {viewed.has(file.path) && (
              <span title={m.pr_file_viewed()} className="flex shrink-0">
                <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
                <span className="sr-only">{m.pr_file_viewed()}</span>
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

function FolderItem({
  folder,
  viewed,
  onReveal,
  depth,
}: {
  folder: FileTreeFolder<PullRequestFile>
  viewed: ReadonlySet<string>
  onReveal: (path: string) => void
  depth: number
}) {
  const [open, setOpen] = useState(true)
  const [, startTransition] = useTransition()
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        title={folder.path}
        onClick={() => startTransition(() => setOpen(!open))}
        style={{ paddingInlineStart: `${depth * 0.75 + 0.25}rem` }}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pe-1.5 text-start text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{folder.name}</span>
      </button>
      {open && <FileTreeFolderView folder={folder} viewed={viewed} onReveal={onReveal} depth={depth + 1} />}
    </li>
  )
}
