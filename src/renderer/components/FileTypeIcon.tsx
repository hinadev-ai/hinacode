import { FolderIcon, FolderOpenIcon, LinkIcon } from "@hinacode/icons"
import { cn } from "cn"
import type { FsEntry } from "../../shared/domain.ts"
import { fileIconSvg } from "../lib/fileIcons.ts"

interface FileTypeIconProps {
  readonly entry: FsEntry
  readonly expanded: boolean
}

export function FileTypeIcon({ entry, expanded }: FileTypeIconProps) {
  const box = cn("flex size-4 shrink-0 items-center justify-center", entry.ignored && "opacity-45")
  if (entry.kind === "file") {
    return (
      <span
        aria-hidden
        className={cn(box, "[&>svg]:size-full")}
        dangerouslySetInnerHTML={{ __html: fileIconSvg(entry.path) }}
      />
    )
  }
  const Icon = entry.kind === "symlink" ? LinkIcon : expanded ? FolderOpenIcon : FolderIcon
  return (
    <span aria-hidden className={box}>
      <Icon className="size-3.5 text-muted-foreground" />
    </span>
  )
}
