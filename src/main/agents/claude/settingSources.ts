import type { SettingSource } from "@anthropic-ai/claude-agent-sdk"

export const settingSources = (_projectTrusted: boolean): Array<SettingSource> => ["user", "project", "local"]
