import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { lazy, Suspense } from "react"
import { projectsAtom } from "../lib/rpc.ts"
import { returnFocus, useUi } from "../stores/ui.ts"
import { Dialog, DialogOverlay, DialogPortal } from "./ui/dialog.tsx"

const ImportSessionPicker = lazy(() => import("./ImportSessionPicker.tsx"))

const close = () => useUi.getState().setImportSessionProjectId(null)

export function ImportSessionDialog() {
  const projectId = useUi((state) => state.importSessionProjectId)
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const project = projects.find((candidate) => candidate.id === projectId)

  return (
    <Dialog open={project !== undefined} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12dvh]">
          <DialogPrimitive.Popup
            finalFocus={returnFocus}
            className="flex max-h-[min(32rem,76dvh)] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none transition-[opacity,scale] duration-150 ease-(--ease-out) data-starting-style:scale-98 data-starting-style:opacity-0"
          >
            {project && (
              <Suspense>
                <ImportSessionPicker key={project.id} project={project} onClose={close} />
              </Suspense>
            )}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPortal>
    </Dialog>
  )
}
