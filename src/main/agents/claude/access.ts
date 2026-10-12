import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"
import type { AccessMode } from "../../../shared/domain.ts"

/** `auto` falls back to accepting edits on models without Claude's auto-mode classifier. */
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
