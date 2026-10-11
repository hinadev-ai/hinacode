import type { SettingSource } from "@anthropic-ai/claude-agent-sdk"

/** Project and local settings can define hooks and allow rules that run before kkcode's approval card, so only trusted projects load them. */
export const settingSources = (projectTrusted: boolean): Array<SettingSource> =>
  projectTrusted ? ["user", "project", "local"] : ["user"]
