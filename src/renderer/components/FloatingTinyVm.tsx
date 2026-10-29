import { lazy, Suspense } from "react"
import { useThreadEnvironment } from "../lib/environments.ts"
import { useSettings } from "../lib/settings.ts"
import { useUi } from "../stores/ui.ts"

const FloatingVm = lazy(() => import("./sidePanel/FloatingVm.tsx"))

/** The thread's tiny VM screen floating over the top right of the conversation, when the user floated it. */
export function FloatingTinyVm({ threadId }: { threadId: string }) {
  const { experimental } = useSettings(useThreadEnvironment(threadId))
  const floating = useUi((state) => state.vmPlacements[threadId] === "floating")
  if (!experimental.tinyVm || !floating) return null
  return (
    <Suspense>
      <FloatingVm threadId={threadId} />
    </Suspense>
  )
}
