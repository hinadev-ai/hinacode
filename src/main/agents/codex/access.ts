import type { AccessMode } from "../../../shared/domain.ts"
import type {
  AskForApproval,
  PermissionProfileToml,
  SandboxConfig,
  SandboxPolicy,
  ThreadStartParams,
  TurnStartParams,
} from "./protocol.ts"

const PERMISSION_PROFILE = "hinacode"

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

type ThreadAccess = Pick<ThreadStartParams, "approvalPolicy" | "sandbox"> & {
  readonly config?: {
    readonly default_permissions: string
    readonly permissions: Record<string, PermissionProfileToml>
  }
}

const permissionProfile = (
  unreadablePaths: ReadonlyArray<string>,
  userSandbox: SandboxConfig | null,
): PermissionProfileToml => {
  const userProfile = userSandbox?.default_permissions ?? null
  const workspaceWrite = userProfile === null ? (userSandbox?.sandbox_workspace_write ?? null) : null
  return {
    extends: userProfile ?? ":workspace",
    ...(workspaceWrite !== null && { network: { enabled: workspaceWrite.network_access } }),
    filesystem: Object.fromEntries([
      ...(workspaceWrite?.writable_roots ?? []).map((root) => [root, "write"]),
      ...unreadablePaths.map((path) => [path, "deny"]),
    ]),
  }
}

export const threadAccess = (
  accessMode: AccessMode,
  unreadablePaths: ReadonlyArray<string>,
  userSandbox: SandboxConfig | null,
): ThreadAccess =>
  accessMode === "full"
    ? { approvalPolicy: approvalPolicies.full, sandbox: "danger-full-access" }
    : {
        approvalPolicy: approvalPolicies[accessMode],
        config: {
          default_permissions: PERMISSION_PROFILE,
          permissions: { [PERMISSION_PROFILE]: permissionProfile(unreadablePaths, userSandbox) },
        },
      }

export const turnAccess = (accessMode: AccessMode, current: SandboxPolicy) => {
  const wanted = sandboxPolicy(accessMode)
  return {
    approvalPolicy: approvalPolicies[accessMode],
    // FIXME: a replaced sandbox policy drops the user's sandbox_workspace_write config
    ...(current.type === wanted.type ? {} : { sandboxPolicy: wanted }),
  } satisfies Partial<TurnStartParams>
}
