import type { Project } from "@shared/domain.ts"
import { call } from "@/lib/connection"
import { useDrafts } from "@/stores/drafts"
import { useThreads } from "@/stores/threads"

export async function createThread(project: Project) {
  const thread = await call("threads.draft", { projectId: project.id })
  useThreads.getState().upsert(thread)
  if (project.kind !== "folder" || useDrafts.getState().workspaces[thread.id]) return thread
  const settings = await call("settings.get", undefined, { server: project.environmentId })
  if (settings.defaultWorkspaceMode === "worktree") {
    const ref = await call("projects.defaultBranch", { id: project.id })
    useDrafts.getState().setWorkspace(thread.id, { mode: "worktree", ref })
  }
  return thread
}
