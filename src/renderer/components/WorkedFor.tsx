import { type ReactNode } from "react"
import { RiArrowRightSLine } from "react-icons/ri"
import { formatWorkDuration, type IndexedMessagePart } from "../lib/assistantPresentation.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"
import { useFindDisclosure } from "./MessagePart.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"

const rowClassName = "flex min-h-8 w-full items-center gap-2 border-b border-border text-xs text-muted-foreground"

export function WorkedFor({
  messageId,
  durationMs,
  work,
  children,
}: {
  messageId: string
  durationMs: number
  work: ReadonlyArray<IndexedMessagePart>
  children: ReactNode
}) {
  const reveal = useUi((state) => state.findReveal)
  const revealHere =
    reveal?.match.messageId === messageId && work.some(({ index }) => index === reveal.match.partIndex) ? reveal : null
  const [open, setOpen] = useFindDisclosure(revealHere)
  const label = (
    <span className="tabular-nums">{m.message_worked_for({ duration: formatWorkDuration(durationMs) })}</span>
  )

  if (work.length === 0)
    return (
      <div data-slot="worked-for" className={cn(rowClassName, "mb-2")}>
        {label}
      </div>
    )

  return (
    <Collapsible data-slot="worked-for" open={open} onOpenChange={setOpen} className="mb-2">
      <CollapsibleTrigger
        className={cn(
          rowClassName,
          "group/trigger pressable rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {label}
        <RiArrowRightSLine
          aria-hidden
          className="size-4 shrink-0 transition-transform duration-150 ease-out group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}
