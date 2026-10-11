import { RiClaudeFill, RiOpenaiFill } from "react-icons/ri"
import type { ProviderId } from "../../shared/agent.ts"

const icons = { claude: RiClaudeFill, codex: RiOpenaiFill } satisfies Record<ProviderId, unknown>

export function ProviderIcon({ provider }: { provider: ProviderId }) {
  const Icon = icons[provider]
  return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
}
