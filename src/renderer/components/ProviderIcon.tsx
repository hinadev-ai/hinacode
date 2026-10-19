import { cn } from "cn"
import { RiClaudeFill, RiMetaFill, RiOpenaiFill } from "react-icons/ri"
import type { ProviderId } from "../../shared/agent.ts"
import { m } from "../paraglide/messages.js"

const icons = {
  claude: { Icon: RiClaudeFill, color: "text-provider-claude" },
  codex: { Icon: RiOpenaiFill, color: "text-provider-codex" },
  muse: { Icon: RiMetaFill, color: "text-provider-muse" },
} satisfies Record<ProviderId, unknown>

export const providerLabel = {
  claude: m.provider_claude,
  codex: m.provider_codex,
  muse: m.provider_muse,
} satisfies Record<ProviderId, () => string>

/** In the agent's brand color, or muted where it marks a tool call, which recedes like the rest of the call. */
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
