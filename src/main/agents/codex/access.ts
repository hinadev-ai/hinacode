import type { AccessMode } from "../../../shared/domain.ts"
import type { AskForApproval, SandboxPolicy, ThreadStartParams, TurnStartParams } from "./protocol.ts"

const approvalPolicies: Record<AccessMode, AskForApproval> = {
  supervised: "untrusted",
  auto: "on-request",
  full: "never",
}

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

export const turnAccess = (accessMode: AccessMode, current: SandboxPolicy) => {
  const wanted = sandboxPolicy(accessMode)
  return {
    approvalPolicy: approvalPolicies[accessMode],
    // FIXME: a replaced sandbox policy drops the user's sandbox_workspace_write config
    ...(current.type === wanted.type ? {} : { sandboxPolicy: wanted }),
  } satisfies Partial<TurnStartParams>
}
