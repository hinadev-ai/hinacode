import { copy } from "./copy"
import { RpcError } from "@shared/transport.ts"

export const errorText = (cause: unknown) => {
  if (cause instanceof RpcError && cause.tag === "FolderMissingError") return copy("mobile_folder_missing")
  if (cause instanceof RpcError && cause.tag === "EnvironmentVersionMismatch") {
    return copy("mobile_environment_version_mismatch", { name: cause.message })
  }
  return cause instanceof Error ? cause.message : String(cause)
}
