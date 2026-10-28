import { useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { RiGitForkLine } from "react-icons/ri"
import type { Message } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { CopyButton } from "./CopyButton.tsx"
import { Button } from "./ui/button.tsx"

/** What the message said, without the tool activity around it. */
const messageText = (message: Message) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n")

/** Shows while the pointer is on the message, or focus is in this row. */
export function MessageActions({ message, className }: { message: Message; className?: string }) {
  const navigate = useNavigate()
  const text = messageText(message)
  const forkPoint = message.completedAt === null ? null : message.forkPoint

  const fork = async () => {
    try {
      const thread = await callPromise("threads.fork", { threadId: message.threadId, messageId: message.id })
      useThreads.getState().upsert(thread)
      await navigate({ to: "/thread/$threadId", params: { threadId: thread.id } })
      useUi.getState().requestComposerFocus()
    } catch (cause) {
      console.error(`Could not fork the thread: ${errorMessage(cause)}`)
    }
  }

  if (text === "" && forkPoint === null) return null
  return (
    <div
      className={cn(
        "flex gap-0.5 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
        className,
      )}
    >
      {text !== "" && <CopyButton value={text} label={m.message_copy()} />}
      {forkPoint !== null && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={m.message_fork()}
          title={m.message_fork()}
          action={fork}
        >
          <RiGitForkLine />
        </Button>
      )}
    </div>
  )
}
