import { m } from "../paraglide/messages.js"
import { RpcError } from "./rpc.ts"

const byTag: Readonly<Record<string, (detail: string) => string>> = {
  NotFoundError: () => m.error_not_found(),
  AccountInUseError: () => m.error_account_in_use(),
  PersistenceError: () => m.error_persistence(),
  ProjectPathTakenError: () => m.error_project_path_taken(),
  ProjectRootInvalidError: () => m.error_project_root_invalid(),
  ProjectFolderNotEmptyError: () => m.error_project_folder_not_empty(),
  PullRequestUrlInvalidError: () => m.error_pull_request_url_invalid(),
  PullRequestDiffTooLargeError: () => m.error_pull_request_diff_too_large(),
  GitHubRateLimitedError: () => m.error_github_rate_limited(),
  GitHubApiError: (detail) => m.error_github_api({ detail }),
  LinearRequestError: () => m.error_linear_request(),
  SchemaError: () => m.error_schema(),
  AgentError: (detail) => m.error_agent({ detail }),
  CommandError: (detail) => m.error_command({ detail }),
  GitCommandError: (detail) => m.error_command({ detail }),
  PortsError: (detail) => m.error_ports({ detail }),
  TerminalError: (detail) => m.error_terminal({ detail }),
  ThreadBusyError: () => m.error_thread_busy(),
  FsAccessError: () => m.error_fs_access(),
  EnvironmentUnauthorized: () => m.error_environment_unauthorized(),
  Defect: (detail) => m.error_unexpected({ detail }),
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof RpcError) return byTag[cause.tag]?.(cause.message) ?? cause.message
  return cause instanceof Error ? cause.message : String(cause)
}

const commandTags = new Set(["CommandError", "GitCommandError"])

export interface ErrorSummary {
  readonly message: string
  readonly detail: string | null
}

export function errorSummary(cause: unknown): ErrorSummary {
  if (cause instanceof RpcError && commandTags.has(cause.tag)) {
    const [command = ""] = cause.message.split(" ", 1)
    return { message: m.error_command_summary({ command }), detail: cause.message }
  }
  return { message: errorMessage(cause), detail: null }
}
