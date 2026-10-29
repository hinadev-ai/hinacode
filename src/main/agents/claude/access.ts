import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"
import type { AccessMode } from "../../../shared/domain.ts"

export const permissionMode = (accessMode: AccessMode, modelSupportsAutoMode: boolean): PermissionMode => {
  switch (accessMode) {
    case "supervised":
      return "default"
    case "auto":
      return modelSupportsAutoMode ? "auto" : "acceptEdits"
    case "full":
      return "bypassPermissions"
  }
}
