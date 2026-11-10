import { cn } from "cn"
import type { ComponentType } from "react"
import {
  RiClaudeFill,
  RiDeepseekFill,
  RiGeminiFill,
  RiGrokAiFill,
  RiMetaFill,
  RiOpenaiFill,
  RiQwenAiFill,
  RiZhipuAiFill,
} from "react-icons/ri"
import type { ProviderId, Subagent } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import { modelBrand, type ModelBrand } from "../lib/modelBrand.ts"
import { m } from "../paraglide/messages.js"
import { MagpieLogoIcon } from "./icons/MagpieLogoIcon.tsx"
import { MistralLogoIcon } from "./icons/MistralLogoIcon.tsx"
import { MoonshotLogoIcon } from "./icons/MoonshotLogoIcon.tsx"
import { OpencodeLogoIcon } from "./icons/OpencodeLogoIcon.tsx"

type MarkIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>
interface Mark {
  readonly Icon: MarkIcon
  readonly color: string
}

const providerMarks = {
  claude: { Icon: RiClaudeFill, color: "text-provider-claude" },
  codex: { Icon: RiOpenaiFill, color: "text-provider-codex" },
  muse: { Icon: RiMetaFill, color: "text-provider-muse" },
  opencode: { Icon: OpencodeLogoIcon, color: "text-provider-opencode" },
  magpie: { Icon: MagpieLogoIcon, color: "text-provider-magpie" },
} satisfies Record<ProviderId, Mark>

const modelMarks = {
  claude: { Icon: RiClaudeFill, color: "text-provider-claude" },
  codex: { Icon: RiOpenaiFill, color: "text-provider-codex" },
  meta: { Icon: RiMetaFill, color: "text-provider-muse" },
  deepseek: { Icon: RiDeepseekFill, color: "text-provider-deepseek" },
  kimi: { Icon: MoonshotLogoIcon, color: "text-provider-kimi" },
  glm: { Icon: RiZhipuAiFill, color: "text-provider-glm" },
  qwen: { Icon: RiQwenAiFill, color: "text-provider-qwen" },
  gemini: { Icon: RiGeminiFill, color: "text-provider-gemini" },
  grok: { Icon: RiGrokAiFill, color: "text-provider-grok" },
  mistral: { Icon: MistralLogoIcon, color: "text-provider-mistral" },
} satisfies Record<ModelBrand, Mark>

export const providerLabel = {
  claude: m.provider_claude,
  codex: m.provider_codex,
  muse: m.provider_muse,
  opencode: m.provider_opencode,
  magpie: m.provider_magpie,
} satisfies Record<ProviderId, () => string>

function Mark({ mark, muted, className }: { mark: Mark; muted: boolean; className?: string }) {
  const { Icon, color } = mark
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", muted ? "text-muted-foreground" : color, className)} />
}

export function ProviderIcon({
  provider,
  muted = false,
  className,
}: {
  provider: ProviderId
  muted?: boolean
  className?: string
}) {
  return <Mark mark={providerMarks[provider]} muted={muted} className={className} />
}

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
  const brand = provider === "magpie" ? modelBrand(model) : null
  if (brand === null) return <ProviderIcon provider={provider} muted={muted} className={className} />
  return (
    <span className="flex shrink-0 items-center">
      <Mark mark={modelMarks[brand]} muted={muted} className={cn("relative z-10", className)} />
      <ProviderIcon
        provider={provider}
        muted={muted}
        className={cn(
          "-ms-1 transition-[margin] duration-150 ease-out group-hover/thread:ms-1 motion-reduce:transition-none",
          className,
        )}
      />
    </span>
  )
}

export function SubagentProviderIcon({
  subagent,
  thread,
  muted,
  className,
}: {
  subagent: Pick<Subagent, "provider" | "model"> | undefined
  thread: Pick<Thread, "provider" | "model">
  muted?: boolean
  className?: string
}) {
  const provider = subagent?.provider ?? thread.provider
  const model = subagent?.model ?? (provider === thread.provider ? thread.model : "")
  return <ThreadProviderIcon provider={provider} model={model} muted={muted} className={className} />
}
