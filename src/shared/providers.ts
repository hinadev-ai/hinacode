import { ProviderId } from "./agent.ts"
import type { Settings } from "./domain.ts"

export interface ProviderCli {
  readonly name: string
  readonly binary: string
  readonly installUrl: string
}

export const providerCli: Record<ProviderId, ProviderCli> = {
  claude: { name: "Claude Code", binary: "claude", installUrl: "https://code.claude.com/docs/en/setup" },
  codex: { name: "Codex", binary: "codex", installUrl: "https://learn.chatgpt.com/docs/codex/cli" },
  muse: { name: "Muse Code", binary: "muse", installUrl: "https://dev.meta.ai/docs/muse-code" },
  cursor: { name: "Cursor", binary: "cursor-agent", installUrl: "https://cursor.com/cli" },
  opencode: { name: "opencode", binary: "opencode", installUrl: "https://opencode.ai/docs" },
}

export const steersRunningTurn: Record<ProviderId, boolean> = {
  claude: true,
  codex: true,
  muse: true,
  cursor: false,
  opencode: false,
}

export const enabledProviders = ({ enabledProviders: chosen }: Pick<Settings, "enabledProviders">) =>
  chosen === null ? ProviderId.literals : ProviderId.literals.filter((provider) => chosen.includes(provider))

export const newThreadProvider = (settings: Pick<Settings, "defaultProvider" | "enabledProviders">): ProviderId => {
  const enabled = enabledProviders(settings)
  return enabled.includes(settings.defaultProvider)
    ? settings.defaultProvider
    : (enabled[0] ?? settings.defaultProvider)
}
