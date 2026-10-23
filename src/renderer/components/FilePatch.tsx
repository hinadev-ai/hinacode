import type { DiffLineAnnotation } from "@pierre/diffs"
import { PatchDiff } from "@pierre/diffs/react"
import { type ReactNode, useId, useState } from "react"
import type { ChangedFileStatus, PullRequestFileStatus } from "../../shared/domain.ts"
import { useTheme } from "../lib/appearance.ts"
import { useClientSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"

export interface FileMark {
  readonly letter: string
  readonly className: string
  readonly label: () => string
}

/** A letter beside the color, so the status never rests on color alone. */
export const fileStatusMark = {
  added: { letter: "A", className: "text-vcs-added", label: m.file_status_added },
  modified: { letter: "M", className: "text-vcs-modified", label: m.file_status_modified },
  deleted: { letter: "D", className: "text-destructive", label: m.file_status_deleted },
  untracked: { letter: "U", className: "text-vcs-added", label: m.file_status_untracked },
  conflict: { letter: "C", className: "text-destructive", label: m.file_status_conflict },
} satisfies Record<ChangedFileStatus, FileMark>

export const pullRequestFileMark = {
  added: fileStatusMark.added,
  modified: fileStatusMark.modified,
  removed: fileStatusMark.deleted,
  renamed: { letter: "R", className: "text-vcs-modified", label: m.file_status_renamed },
  copied: { letter: "C", className: "text-vcs-added", label: m.file_status_copied },
} satisfies Record<PullRequestFileStatus, FileMark>

// PatchDiff renders a whole file in one frame, about 0.07 ms per line: a 12k-line lockfile blocked for 860 ms.
// Past this many changed lines the file is almost always generated, so it waits until the user asks for it.
const LARGE_DIFF_LINES = 1000

interface FileDiffRowProps<A> {
  readonly path: string
  readonly title?: string
  readonly mark: FileMark
  readonly added: number
  readonly removed: number
  readonly patch: string | undefined
  readonly open: boolean
  readonly onToggle: () => void
  readonly badge?: ReactNode
  /** Shown below the row, open or not. */
  readonly notes?: ReactNode
  readonly lineAnnotations?: Array<DiffLineAnnotation<A>>
  readonly renderAnnotation?: (annotation: DiffLineAnnotation<A>) => ReactNode
}

export function FileDiffRow<A>({
  path,
  title = path,
  mark,
  added,
  removed,
  patch,
  open,
  onToggle,
  badge,
  notes,
  lineAnnotations,
  renderAnnotation,
}: FileDiffRowProps<A>) {
  const diffId = useId()
  const [showLarge, setShowLarge] = useState(false)
  const theme = useTheme(useClientSettings().appearance.theme)

  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={diffId}
        onClick={onToggle}
        className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted"
      >
        <abbr title={mark.label()} className={`w-3 shrink-0 font-mono no-underline ${mark.className}`}>
          {mark.letter}
        </abbr>
        <span className="min-w-0 flex-1 truncate font-mono" title={title}>
          {path}
        </span>
        {badge}
        <span className="shrink-0 font-mono tabular-nums" aria-label={m.diff_line_counts({ added, removed })}>
          <span aria-hidden className="text-vcs-added">
            +{added}
          </span>{" "}
          <span aria-hidden className="text-destructive">
            −{removed}
          </span>
        </span>
      </button>
      {notes}
      {open && (
        <div id={diffId} className="overflow-hidden rounded-md border border-border text-xs">
          {patch === undefined ? (
            <p className="p-2 text-muted-foreground">{m.diff_file_missing()}</p>
          ) : added + removed > LARGE_DIFF_LINES && !showLarge ? (
            <div className="flex items-center justify-between gap-2 p-2">
              <p className="text-muted-foreground">{m.diff_large({ lines: added + removed })}</p>
              <Button variant="outline" size="xs" onClick={() => setShowLarge(true)}>
                {m.diff_large_show()}
              </Button>
            </div>
          ) : (
            <PatchDiff
              patch={patch}
              lineAnnotations={lineAnnotations}
              renderAnnotation={renderAnnotation}
              options={{
                diffStyle: "unified",
                theme: theme.codeTheme,
                themeType: theme.scheme,
                overflow: "wrap",
                disableFileHeader: true,
              }}
            />
          )}
        </div>
      )}
    </li>
  )
}
