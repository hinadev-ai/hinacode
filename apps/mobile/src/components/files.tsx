import type { Thread } from "@shared/domain.ts"
import { EmptyState } from "@/components/ui"

/** The thread's workspace: a folder listing, a path filter and a content search. */
export function FilesPanel(_props: { thread: Thread }) {
  return <EmptyState icon="RiFolderLine" title="Files" />
}
