import { cn } from "cn"
import { RiClaudeFill, RiMetaFill, RiOpenaiFill } from "react-icons/ri"
import type { ProviderId } from "../../shared/agent.ts"
import { m } from "../paraglide/messages.js"
import { MagpieLogoIcon } from "./icons/MagpieLogoIcon.tsx"
import { OpencodeLogoIcon } from "./icons/OpencodeLogoIcon.tsx"

const icons = {
  claude: { Icon: RiClaudeFill, color: "text-provider-claude" },
  codex: { Icon: RiOpenaiFill, color: "text-provider-codex" },
  muse: { Icon: RiMetaFill, color: "text-provider-muse" },
  opencode: { Icon: OpencodeLogoIcon, color: "text-provider-opencode" },
  magpie: { Icon: MagpieLogoIcon, color: "text-provider-magpie" },
} satisfies Record<ProviderId, unknown>

export const providerLabel = {
  claude: m.provider_claude,
  codex: m.provider_codex,
  muse: m.provider_muse,
  opencode: m.provider_opencode,
  magpie: m.provider_magpie,
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

const upstreams: Record<string, ProviderId> = { claude: "claude", anthropic: "claude", codex: "codex", openai: "codex" }

export const magpieUpstream = (model: string): ProviderId | null => upstreams[model.split("/")[0] ?? ""] ?? null

export function ThreadProviderIcon({
  provider,
  model,
  muted = false,
  className,
}: {
  provider: ProviderId
  model: string
  muted?: boolean
  className?: string
}) {
  const upstream = provider === "magpie" ? magpieUpstream(model) : null
  if (upstream === null) return <ProviderIcon provider={provider} muted={muted} className={className} />
  return (
    <span className="flex shrink-0 items-center">
      <ProviderIcon provider={provider} muted={muted} className={className} />
      <ProviderIcon
        provider={upstream}
        muted={muted}
        className={cn(
          "-ms-1 transition-[margin] duration-150 ease-out group-hover/thread:ms-1 motion-reduce:transition-none",
          className,
        )}
      />
    </span>
  )
}
