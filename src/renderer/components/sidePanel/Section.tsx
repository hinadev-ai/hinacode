import { type ReactNode, useId } from "react"
import { ScrollArea } from "../ui/scroll-area.tsx"

/** A titled region inside a view, named after its heading so tests and screen readers can find it. */
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  )
}

/** The scrolling body most views use. */
export function ViewBody({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-6 p-4">{children}</div>
    </ScrollArea>
  )
}
