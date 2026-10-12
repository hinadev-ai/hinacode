import type { useNavigate } from "@tanstack/react-router"
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
