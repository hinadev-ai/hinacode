import { copy } from "./copy"
import { RpcError } from "./transport"

export const errorText = (cause: unknown) => {
  if (cause instanceof RpcError && cause.tag === "FolderMissingError") return copy("mobile_folder_missing")
  return cause instanceof Error ? cause.message : String(cause)
}
