import type { AccessMode } from "../../../shared/domain.ts"
import type { AskForApproval, SandboxPolicy, ThreadStartParams, TurnStartParams } from "./protocol.ts"

const approvalPolicies: Record<AccessMode, AskForApproval> = {
  supervised: "untrusted",
  auto: "on-request",
  full: "never",
}

/** Codex's defaults for each sandbox, used when a turn has to change the thread's. */
const sandboxPolicy = (accessMode: AccessMode): SandboxPolicy =>
  accessMode === "full"
    ? { type: "dangerFullAccess" }
    : {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }

export const threadAccess = (accessMode: AccessMode) =>
  ({
    approvalPolicy: approvalPolicies[accessMode],
    sandbox: accessMode === "full" ? "danger-full-access" : "workspace-write",
  }) satisfies ThreadStartParams

/**
 * Overrides for `turn/start`, which is how a loaded thread changes mode: resuming a running thread
 * ignores its overrides. The sandbox is only replaced when its kind changes, because the
 * replacement is a whole policy and would drop the user's `sandbox_workspace_write` config.
 */
export const turnAccess = (accessMode: AccessMode, current: SandboxPolicy) => {
  const wanted = sandboxPolicy(accessMode)
  return {
    approvalPolicy: approvalPolicies[accessMode],
    ...(current.type === wanted.type ? {} : { sandboxPolicy: wanted }),
  } satisfies Partial<TurnStartParams>
}
