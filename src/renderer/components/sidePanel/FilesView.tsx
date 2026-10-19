import type { Thread } from "../../../shared/domain.ts"
import { useThreadRoot } from "../../lib/threadRoot.ts"
import { FileExplorer } from "../FileExplorer.tsx"

export function FilesView({ thread }: { thread: Thread }) {
  const root = useThreadRoot(thread)
  if (root === undefined) return null
  return <FileExplorer key={root.path} thread={thread} root={root.path} worktreeId={root.worktreeId} />
}
