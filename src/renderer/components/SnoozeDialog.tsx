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
import { useUi } from "../stores/ui.ts"
import { Dialog, DialogOverlay, DialogPortal } from "./ui/dialog.tsx"

// The picker parses typed times with chrono-node, which loads when the dialog first opens.
const SnoozePicker = lazy(() => import("./SnoozePicker.tsx"))

/** Sets or clears a thread's snooze, and offers to put the old one back. */
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
      label: m.snooze_undo(),
      onClick: () =>
        void update(thread.snoozedUntil).then(upsert, (cause: unknown) =>
          toast.error(m.sidebar_unsnooze_failed({ message: errorMessage(cause) })),
        ),
    },
  })
}

const close = () => useUi.getState().setSnoozeThreadId(null)

// Checked once the popup has unmounted and again once the snoozed row has moved to its new list, since either
// can take the element focus went back to.
const keepFocus = () => {
  if (document.activeElement === document.body) useUi.getState().requestComposerFocus()
}

/** The snooze picker for the thread `useUi.snoozeThreadId` names. Mount once, in the app shell. */
export function SnoozeDialog() {
  const threadId = useUi((state) => state.snoozeThreadId)
  const thread = useThreads((state) => (threadId === null ? undefined : state.byId[threadId]))

  return (
    <Dialog
      open={thread !== undefined}
      onOpenChange={(open) => (open ? undefined : close())}
      onOpenChangeComplete={(open) => {
        if (!open) requestAnimationFrame(keepFocus)
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12dvh]">
          <DialogPrimitive.Popup className="flex max-h-[min(24rem,76dvh)] w-full max-w-md flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none transition-[opacity,scale] duration-150 ease-(--ease-out) data-starting-style:scale-98 data-starting-style:opacity-0">
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
