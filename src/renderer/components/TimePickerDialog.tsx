import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { lazy, Suspense } from "react"
import { returnFocus } from "../stores/ui.ts"
import type { TimePickerProps } from "./TimePicker.tsx"
import { Dialog, DialogOverlay, DialogPortal } from "./ui/dialog.tsx"

const TimePicker = lazy(() => import("./TimePicker.tsx"))

export function TimePickerDialog({ open, ...picker }: TimePickerProps & { readonly open: boolean }) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : picker.onClose())}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12dvh]">
          <DialogPrimitive.Popup
            finalFocus={returnFocus}
            className="flex max-h-[min(24rem,76dvh)] w-full max-w-md flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 transition-[opacity,scale] duration-150 ease-out outline-none data-starting-style:scale-98 data-starting-style:opacity-0"
          >
            {open && (
              <Suspense>
                <TimePicker {...picker} />
              </Suspense>
            )}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPortal>
    </Dialog>
  )
}
