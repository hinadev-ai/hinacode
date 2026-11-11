import type { ModelInfo, ProviderId } from "./agent.ts"
import type { AccessMode } from "./domain.ts"

export type AccessBehavior =
  | "askEditsAndCommands"
  | "askUnlessReadOnly"
  | "askProtectedWrites"
  | "askEveryTool"
  | "autoApprovesSafeActions"
  | "acceptEdits"
  | "sandboxed"
  | "aiReview"
  | "bypass"
  | "unrestricted"

const behaviors: Record<ProviderId, Record<AccessMode, AccessBehavior>> = {
  claude: { supervised: "askEditsAndCommands", auto: "autoApprovesSafeActions", full: "bypass" },
  magpie: { supervised: "askEditsAndCommands", auto: "autoApprovesSafeActions", full: "bypass" },
  codex: { supervised: "askUnlessReadOnly", auto: "sandboxed", full: "bypass" },
  muse: { supervised: "askProtectedWrites", auto: "aiReview", full: "unrestricted" },
  opencode: { supervised: "askEveryTool", auto: "acceptEdits", full: "bypass" },
}

export const accessBehavior = (
  provider: ProviderId,
  accessMode: AccessMode,
  model: Pick<ModelInfo, "autoMode"> | undefined,
): AccessBehavior => {
  const behavior = behaviors[provider][accessMode]
  return behavior === "autoApprovesSafeActions" && !model?.autoMode ? "acceptEdits" : behavior
}
