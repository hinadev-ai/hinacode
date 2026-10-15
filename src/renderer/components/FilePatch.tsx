import { PatchDiff } from "@pierre/diffs/react"
import type { ChangedFileStatus } from "../../shared/domain.ts"
import { useTheme } from "../lib/appearance.ts"
import { useClientSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"

export const fileStatusLabel = {
  added: m.file_status_added,
  modified: m.file_status_modified,
  deleted: m.file_status_deleted,
  untracked: m.file_status_untracked,
  conflict: m.file_status_conflict,
} satisfies Record<ChangedFileStatus, () => string>

/** A letter beside the color, so the status never rests on color alone. */
export const fileStatusMark = {
  added: { letter: "A", className: "text-vcs-added" },
  modified: { letter: "M", className: "text-vcs-modified" },
  deleted: { letter: "D", className: "text-destructive" },
  untracked: { letter: "U", className: "text-vcs-added" },
  conflict: { letter: "C", className: "text-destructive" },
} satisfies Record<ChangedFileStatus, { letter: string; className: string }>

/** The single-file section of a combined `git diff`, found by its `diff --git a/… b/<path>` header. */
const patchForFile = (patch: string, path: string) =>
  patch.split(/^(?=diff --git )/m).find((chunk) => chunk.slice(0, chunk.indexOf("\n")).endsWith(` b/${path}`))

/** One file's diff out of a worktree's combined patch, as the Changes list and the file tree show it. */
export function FilePatch({ patch, path }: { patch: string; path: string }) {
  const filePatch = patchForFile(patch, path)
  const theme = useTheme(useClientSettings().appearance.theme)
  if (!filePatch) return <p className="p-2 text-muted-foreground">{m.diff_file_missing()}</p>
  return (
    <PatchDiff
      patch={filePatch}
      options={{
        diffStyle: "unified",
        theme: theme.codeTheme,
        themeType: theme.scheme,
        overflow: "wrap",
        disableFileHeader: true,
      }}
    />
  )
}
