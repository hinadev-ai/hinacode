import { m } from "../paraglide/messages.js"
import { RpcError } from "./rpc.ts"

/**
 * Main-process errors arrive with an English message. Known tags get a translated sentence; tags whose
 * message carries the useful part (git stderr, the agent's own words) keep it as a detail.
 */
const byTag: Readonly<Record<string, (detail: string) => string>> = {
  NotFoundError: () => m.error_not_found(),
  PersistenceError: () => m.error_persistence(),
  ProjectPathTakenError: () => m.error_project_path_taken(),
  ProjectRootInvalidError: () => m.error_project_root_invalid(),
  PullRequestUrlInvalidError: () => m.error_pull_request_url_invalid(),
  LinearRequestError: () => m.error_linear_request(),
  SchemaError: () => m.error_schema(),
  AgentError: (detail) => m.error_agent({ detail }),
  CommandError: (detail) => m.error_command({ detail }),
  GitCommandError: (detail) => m.error_command({ detail }),
  PortsError: (detail) => m.error_ports({ detail }),
  Defect: (detail) => m.error_unexpected({ detail }),
}

/** A sentence to show the user for anything an rpc call or atom failed with. */
export function errorMessage(cause: unknown): string {
  if (cause instanceof RpcError) return byTag[cause.tag]?.(cause.message) ?? cause.message
  return cause instanceof Error ? cause.message : String(cause)
}
