import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { lazy, Suspense } from "react"
import { toast } from "sonner"
import type { Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { formatSnoozeTime } from "../lib/snooze.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useThreads } from "../stores/threads.ts"
import { returnFocus, useUi } from "../stores/ui.ts"
import { Dialog, DialogOverlay, DialogPortal } from "./ui/dialog.tsx"

const SnoozePicker = lazy(() => import("./SnoozePicker.tsx"))

export async function snoozeThread(thread: Thread, until: Date | null) {
  const { upsert } = useThreads.getState()
  const update = (snoozedUntil: string | null) => callPromise("threads.update", { id: thread.id, snoozedUntil })
  try {
    upsert(await update(until?.toISOString() ?? null))
  } catch (cause) {
    toast.error((until ? m.snooze_failed : m.sidebar_unsnooze_failed)({ message: errorMessage(cause) }))
    return
  }
  if (!until) return
  toast(m.snooze_done({ time: formatSnoozeTime(until, new Date(), getLocale()) }), {
    action: {
      label: m.common_undo(),
      onClick: () =>
        void update(thread.snoozedUntil).then(upsert, (cause: unknown) =>
          toast.error(m.sidebar_unsnooze_failed({ message: errorMessage(cause) })),
        ),
    },
  })
}

const close = () => useUi.getState().setSnoozeThreadId(null)

const keepFocus = () => {
  if (document.activeElement === document.body) useUi.getState().requestComposerFocus()
}

export function SnoozeDialog() {
  const threadId = useUi((state) => state.snoozeThreadId)
  const thread = useThreads((state) => (threadId === null ? undefined : state.byId[threadId]))

  return (
    <Dialog open={thread !== undefined} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12dvh]">
          <DialogPrimitive.Popup
            finalFocus={returnFocus}
            className="flex max-h-[min(24rem,76dvh)] w-full max-w-md flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 transition-[opacity,scale] duration-150 ease-out outline-none data-starting-style:scale-98 data-starting-style:opacity-0"
          >
            {thread && (
              <Suspense>
                <SnoozePicker
                  key={thread.id}
                  thread={thread}
                  onClose={close}
                  onChoose={(until) => {
                    close()
                    void snoozeThread(thread, until).then(() => requestAnimationFrame(keepFocus))
                  }}
                />
              </Suspense>
            )}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPortal>
    </Dialog>
  )
}
