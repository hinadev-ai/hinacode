import type { useNavigate } from "@tanstack/react-router"
import type { Thread } from "../../shared/domain.ts"
import { useDrafts } from "../stores/drafts.ts"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { errorMessage } from "./errorMessage.ts"
import { callPromise } from "./rpc.ts"

/** Creates an empty thread and opens it with the composer focused, where its agent and workspace are picked. */
export async function startThread(projectId: string, navigate: ReturnType<typeof useNavigate>) {
  try {
    const thread = await callPromise("threads.create", { projectId })
    useThreads.getState().upsert(thread)
    await navigate({ to: "/thread/$threadId", params: { threadId: thread.id } })
    useUi.getState().requestComposerFocus()
  } catch (cause) {
    console.error(`Could not create a thread: ${errorMessage(cause)}`)
  }
}

/**
 * Moves a thread with no messages yet to `projectId`, the same repository or the chats on another machine. A thread lives on
 * the machine it was created on, so this creates one there, hands it the draft and agent, and deletes the old one.
 * Staged attachments stay behind with their files on the old machine.
 */
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
