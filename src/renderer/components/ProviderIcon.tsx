import { cn } from "cn"
import { RiClaudeFill, RiMetaFill, RiOpenaiFill } from "react-icons/ri"
import type { ProviderId } from "../../shared/agent.ts"
import { m } from "../paraglide/messages.js"
import { CursorIcon } from "./icons/CursorIcon.tsx"
import { OpencodeIcon } from "./icons/OpencodeIcon.tsx"

const icons = {
  claude: { Icon: RiClaudeFill, color: "text-provider-claude" },
  codex: { Icon: RiOpenaiFill, color: "text-provider-codex" },
  muse: { Icon: RiMetaFill, color: "text-provider-muse" },
  cursor: { Icon: CursorIcon, color: "text-provider-cursor" },
  opencode: { Icon: OpencodeIcon, color: "text-provider-opencode" },
} satisfies Record<ProviderId, unknown>

export const providerLabel = {
  claude: m.provider_claude,
  codex: m.provider_codex,
  muse: m.provider_muse,
  cursor: m.provider_cursor,
  opencode: m.provider_opencode,
} satisfies Record<ProviderId, () => string>

export function ProviderIcon({
  provider,
  muted = false,
  className,
}: {
  provider: ProviderId
  muted?: boolean
  className?: string
}) {
  const { Icon, color } = icons[provider]
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", muted ? "text-muted-foreground" : color, className)} />
}
