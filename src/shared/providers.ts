import type { ProviderId } from "./agent.ts"

export interface ProviderInfo {
  readonly name: string
  readonly binary: string
  readonly installUrl: string
  readonly steersRunningTurn: boolean
  readonly autoCompacts: boolean
  readonly movesCommandsToBackground: boolean
  readonly subagentModels: "listed" | "picked"
}

export const providerInfo: Record<ProviderId, ProviderInfo> = {
  claude: {
    name: "Claude Code",
    binary: "claude",
    installUrl: "https://code.claude.com/docs/en/setup",
    steersRunningTurn: true,
    autoCompacts: true,
    movesCommandsToBackground: true,
    subagentModels: "listed",
  },
  codex: {
    name: "Codex",
    binary: "codex",
    installUrl: "https://learn.chatgpt.com/docs/codex/cli",
    steersRunningTurn: true,
    autoCompacts: true,
    movesCommandsToBackground: false,
    subagentModels: "listed",
  },
  muse: {
    name: "Muse Code",
    binary: "muse",
    installUrl: "https://dev.meta.ai/docs/muse-code",
    steersRunningTurn: true,
    autoCompacts: true,
    movesCommandsToBackground: false,
    subagentModels: "listed",
  },
  opencode: {
    name: "opencode",
    binary: "opencode",
    installUrl: "https://opencode.ai/docs",
    steersRunningTurn: false,
    autoCompacts: false,
    movesCommandsToBackground: false,
    subagentModels: "picked",
  },
}
