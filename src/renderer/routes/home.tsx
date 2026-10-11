import { RiChatThreadLine } from "react-icons/ri"
import { m } from "../paraglide/messages.js"

export function HomeRoute() {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-2 text-center">
      <RiChatThreadLine aria-hidden className="size-8 text-muted-foreground" />
      <h1 className="text-base font-semibold">{m.home_title()}</h1>
      <p className="text-sm text-muted-foreground">{m.home_hint()}</p>
    </div>
  )
}
