import type { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import type { Thread } from "../../shared/domain.ts"
import { useDrafts } from "../stores/drafts.ts"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { environmentOf } from "./environments.ts"
import { errorMessage } from "./errorMessage.ts"
import { registry } from "./registry.ts"
import { callPromise, projectsAtom } from "./rpc.ts"

async function pickRememberedWorkspace(thread: Thread) {
  const project = AsyncResult.getOrElse(registry.get(projectsAtom), () => []).find(
    (candidate) => candidate.id === thread.projectId,
  )
  if (project?.kind !== "folder") return
  const settings = await callPromise("settings.get", undefined, { environment: environmentOf(project) })
  if (settings.defaultWorkspaceMode !== "worktree") return
  const ref = await callPromise("projects.defaultBranch", { id: project.id })
  useDrafts.getState().setWorkspace(thread.id, { mode: "worktree", ref })
}

export async function startThread(projectId: string, navigate: ReturnType<typeof useNavigate>) {
  try {
    const thread = await callPromise("threads.create", { projectId })
    useThreads.getState().upsert(thread)
    await pickRememberedWorkspace(thread)
    await navigate({ to: "/thread/$threadId", params: { threadId: thread.id } })
    useUi.getState().requestComposerFocus()
  } catch (cause) {
    console.error(`Could not create a thread: ${errorMessage(cause)}`)
  }
}

export async function moveUnstartedThread(thread: Thread, projectId: string, navigate: ReturnType<typeof useNavigate>) {
  const created = await callPromise("threads.create", { projectId })
  const moved =
    created.provider === thread.provider
      ? created
      : await callPromise("threads.update", { id: created.id, provider: thread.provider })
  useThreads.getState().upsert(moved)
  const draft = useDrafts.getState().take(thread.id)
  useDrafts.getState().restore(moved.id, { ...draft, attachments: [] })
  await navigate({ to: "/thread/$threadId", params: { threadId: moved.id }, replace: true })
  useUi.getState().requestComposerFocus()
  await callPromise("threads.delete", { id: thread.id, removeWorktree: false })
}
