import type { ChangedFileStatus } from "../../shared/domain.ts"
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
