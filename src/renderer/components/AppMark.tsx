import { cn } from "cn"

/** The app icon (assets/icon.svg) drawn in CSS, so it scales without an image request. */
export function AppMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center bg-[#7c3aed] font-semibold text-white shadow-[inset_0_1px_0_oklch(1_0_0/25%)]",
        className,
      )}
    >
      K
    </span>
  )
}
