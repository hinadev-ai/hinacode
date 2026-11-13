import {
  DEFAULT_THEMES,
  type DiffLineAnnotation,
  type SelectedLineRange,
  getFiletypeFromFileName,
  getSharedHighlighter,
  getThemes,
} from "@pierre/diffs"
import { cn } from "cn"
import { PatchDiff } from "@pierre/diffs/react"
import { createContext, type ReactNode, Suspense, use, useId, useState } from "react"
import type { ChangedFileStatus, PullRequestFileStatus } from "../../shared/domain.ts"
import { useTheme } from "../lib/appearance.ts"
import { useClientSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import {
  ArrowRightIcon,
  ChevronRightIcon,
  CopyIcon,
  type IconComponent,
  MinusIcon,
  PlusIcon,
  WarningIcon,
} from "@hinacode/icons"
import { Button } from "./ui/button.tsx"
import "../lib/codeThemes.ts"

interface FileMark {
  readonly letter: string
  readonly Glyph: IconComponent | null
  readonly className: string
  readonly label: () => string
  readonly dashed?: boolean
}

export const fileStatusMark = {
  added: { letter: "A", Glyph: PlusIcon, className: "text-vcs-added", label: m.file_status_added },
  modified: { letter: "M", Glyph: null, className: "text-vcs-modified", label: m.file_status_modified },
  deleted: { letter: "D", Glyph: MinusIcon, className: "text-destructive", label: m.file_status_deleted },
  untracked: {
    letter: "U",
    Glyph: PlusIcon,
    className: "text-vcs-added",
    label: m.file_status_untracked,
    dashed: true,
  },
  conflict: { letter: "C", Glyph: WarningIcon, className: "text-destructive", label: m.file_status_conflict },
} satisfies Record<ChangedFileStatus, FileMark>

export const pullRequestFileMark = {
  added: fileStatusMark.added,
  modified: fileStatusMark.modified,
  removed: fileStatusMark.deleted,
  renamed: { letter: "R", Glyph: ArrowRightIcon, className: "text-vcs-modified", label: m.file_status_renamed },
  copied: { letter: "C", Glyph: CopyIcon, className: "text-vcs-added", label: m.file_status_copied },
} satisfies Record<PullRequestFileStatus, FileMark>

function StatusMark({ mark }: { mark: FileMark }) {
  return (
    <span
      title={mark.label()}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-current",
        mark.dashed && "border-dashed",
        mark.className,
      )}
    >
      {mark.Glyph ? (
        <mark.Glyph aria-hidden className="size-2.5" />
      ) : (
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
      )}
      <span className="sr-only">{mark.label()}</span>
    </span>
  )
}

export function FilePath({
  path,
  title = path,
  className,
  mono = true,
}: {
  path: string
  title?: string
  className?: string
  mono?: boolean
}) {
  const nameStart = path.lastIndexOf("/") + 1
  return (
    <span className={cn("flex min-w-0", mono && "font-mono", className)} title={title}>
      <span className="min-w-0 truncate text-muted-foreground">{path.slice(0, nameStart)}</span>
      <span className={cn("max-w-full shrink-0 truncate", !mono && "font-medium")}>{path.slice(nameStart)}</span>
    </span>
  )
}

export type DiffStyle = "unified" | "split"

export const DiffStyleContext = createContext<DiffStyle>("unified")

const highlighters = new Map<string, Promise<unknown>>()

const highlighterFor = (theme: string | undefined, path: string) => {
  const language = getFiletypeFromFileName(path)
  const key = `${theme ?? ""}\0${language}`
  let loaded = highlighters.get(key)
  if (loaded === undefined) {
    loaded = getSharedHighlighter({ themes: getThemes(theme ?? DEFAULT_THEMES), langs: ["text", language] }).catch(
      () => null,
    )
    highlighters.set(key, loaded)
  }
  return loaded
}

// FIXME: without a worker pool, a PatchDiff rendered before its language loads stays empty, so this waits for it
function WhenHighlighterLoads({ highlighter, children }: { highlighter: Promise<unknown>; children: ReactNode }) {
  use(highlighter)
  return children
}

// FIXME: PatchDiff renders a whole file in one frame, about 0.07 ms per line
const LARGE_DIFF_LINES = 1000

interface FileDiffRowProps<A> {
  readonly path: string
  readonly title?: string
  readonly anchorId?: string
  readonly mark: FileMark
  readonly added: number
  readonly removed: number
  readonly patch: string | undefined
  readonly open: boolean
  readonly onToggle: () => void
  readonly badge?: ReactNode
  readonly muted?: boolean
  readonly actions?: ReactNode
  readonly notes?: ReactNode
  readonly lineAnnotations?: Array<DiffLineAnnotation<A>>
  readonly renderAnnotation?: (annotation: DiffLineAnnotation<A>) => ReactNode
  readonly onCommentLines?: (range: SelectedLineRange) => void
  readonly selectedLines?: SelectedLineRange | null
  readonly preview?: ReactNode
}

export function FileDiffRow<A>({
  path,
  title = path,
  anchorId,
  mark,
  added,
  removed,
  patch,
  open,
  onToggle,
  badge,
  muted = false,
  actions,
  notes,
  lineAnnotations,
  renderAnnotation,
  onCommentLines,
  selectedLines,
  preview,
}: FileDiffRowProps<A>) {
  const diffId = useId()
  const [showLarge, setShowLarge] = useState(false)
  const theme = useTheme(useClientSettings().appearance.theme)
  const diffStyle = use(DiffStyleContext)

  return (
    <li id={anchorId} className="flex scroll-mt-2 flex-col gap-1">
      <div
        className={cn("group/row flex min-w-0 items-center gap-0.5 rounded-md", open && "sticky top-0 z-10 bg-muted")}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={diffId}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1.5 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <StatusMark mark={mark} />
          <FilePath
            path={path}
            title={title}
            mono={false}
            className={cn("flex-1 transition-colors", muted && "text-muted-foreground")}
          />
          {badge}
          <span className="shrink-0 font-mono tabular-nums">
            <span aria-hidden className={added === 0 ? "text-muted-foreground" : "text-vcs-added"}>
              +{added}
            </span>{" "}
            <span aria-hidden className={removed === 0 ? "text-muted-foreground" : "text-destructive"}>
              −{removed}
            </span>
            <span className="sr-only select-none">{m.diff_line_counts({ added, removed })}</span>
          </span>
        </button>
        {actions}
      </div>
      {notes}
      {open && (
        <div id={diffId} className="overflow-hidden rounded-md border border-border text-xs">
          {preview ? (
            preview
          ) : patch === undefined ? (
            <p className="p-2 text-muted-foreground">{m.diff_file_missing()}</p>
          ) : added + removed > LARGE_DIFF_LINES && !showLarge ? (
            <div className="flex items-center justify-between gap-2 p-2">
              <p className="text-muted-foreground">{m.diff_large({ lines: added + removed })}</p>
              <Button variant="outline" size="xs" onClick={() => setShowLarge(true)}>
                {m.diff_large_show()}
              </Button>
            </div>
          ) : (
            <Suspense fallback={<p className="p-2 text-muted-foreground">{m.diff_loading()}</p>}>
              <WhenHighlighterLoads highlighter={highlighterFor(theme.codeTheme, path)}>
                <PatchDiff
                  patch={patch}
                  lineAnnotations={lineAnnotations}
                  renderAnnotation={renderAnnotation}
                  selectedLines={selectedLines}
                  options={{
                    diffStyle,
                    theme: theme.codeTheme,
                    themeType: theme.scheme,
                    overflow: "wrap",
                    disableFileHeader: true,
                    ...(onCommentLines && {
                      enableGutterUtility: true,
                      enableLineSelection: true,
                      onGutterUtilityClick: onCommentLines,
                    }),
                  }}
                />
              </WhenHighlighterLoads>
            </Suspense>
          )}
        </div>
      )}
    </li>
  )
}
