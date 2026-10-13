import { RiClaudeFill, RiMetaFill, RiOpenaiFill } from "react-icons/ri"
import type { ProviderId } from "../../shared/agent.ts"
import { m } from "../paraglide/messages.js"

const icons = { claude: RiClaudeFill, codex: RiOpenaiFill, muse: RiMetaFill } satisfies Record<ProviderId, unknown>

export const providerLabel = {
  claude: m.provider_claude,
  codex: m.provider_codex,
  muse: m.provider_muse,
} satisfies Record<ProviderId, () => string>

export function ProviderIcon({ provider }: { provider: ProviderId }) {
  const Icon = icons[provider]
  return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
}
