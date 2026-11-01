import { cn } from "cn"
import { errorSummary } from "../lib/errorMessage.ts"
import { m } from "../paraglide/messages.js"
import { ChevronRightIcon } from "./icons/ChevronRightIcon.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx"

export function ErrorNotice({
  cause,
  describe,
  className,
}: {
  cause: unknown
  describe: (message: string) => string
  className?: string
}) {
  const { message, detail } = errorSummary(cause)
  return (
    <div role="alert" className={cn("flex flex-col gap-1 text-xs", className)}>
      <p className="wrap-anywhere text-destructive">{describe(message)}</p>
      {detail && (
        <Collapsible>
          <CollapsibleTrigger className="group/trigger -ml-1 flex items-center gap-1 rounded-sm px-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-panel-open:text-foreground">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 transition-transform group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
            />
            {m.error_details()}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1 font-mono text-2xs whitespace-pre-wrap text-muted-foreground select-text wrap-anywhere">
              {detail}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
