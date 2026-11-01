import type { useNavigate } from "@tanstack/react-router"
import type { Project, Thread } from "../../shared/domain.ts"
import { emptyDraft, useDrafts } from "../stores/drafts.ts"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { environmentOf } from "./environments.ts"
import { errorMessage } from "./errorMessage.ts"
import { callPromise } from "./rpc.ts"

async function pickRememberedWorkspace(thread: Thread, project: Project) {
  if (project.kind !== "folder" || useDrafts.getState().byThreadId[thread.id]?.workspace) return
  const settings = await callPromise("settings.get", undefined, { environment: environmentOf(project) })
  if (settings.defaultWorkspaceMode !== "worktree") return
  const ref = await callPromise("projects.defaultBranch", { id: project.id })
  useDrafts.getState().setWorkspace(thread.id, { mode: "worktree", ref })
}

export async function startThread(project: Project, navigate: ReturnType<typeof useNavigate>) {
  try {
    const draft = await callPromise("threads.draft", { projectId: project.id })
    useThreads.getState().upsert(draft)
    await pickRememberedWorkspace(draft, project)
    await navigate({ to: "/thread/$threadId", params: { threadId: draft.id } })
    useUi.getState().requestComposerFocus()
  } catch (cause) {
    console.error(`Could not open a new thread: ${errorMessage(cause)}`)
  }
}

export async function moveDraft(thread: Thread, projectId: string, navigate: ReturnType<typeof useNavigate>) {
  const target = await callPromise("threads.draft", { projectId })
  useThreads.getState().upsert(target)
  const { text, comments } = useDrafts.getState().take(thread.id)
  useDrafts.getState().restore(target.id, { ...emptyDraft, text, comments })
  await navigate({ to: "/thread/$threadId", params: { threadId: target.id }, replace: true })
  useUi.getState().requestComposerFocus()
  if (thread.status !== "draft") await callPromise("threads.delete", { id: thread.id, removeWorktree: false })
}
