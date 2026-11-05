import { describe, expect, it } from "vitest"
import { copy } from "./copy"
import { errorText } from "./error-text"
import { RpcError } from "@shared/transport.ts"

describe("errorText", () => {
  it("says the thread's folder is missing instead of the server's raw message", () => {
    const cause = new RpcError("FolderMissingError", "The folder /wt is missing. It was moved or deleted.")
    expect(errorText(cause)).toBe(copy("mobile_folder_missing"))
  })

  it("shows any other rpc error's message as it is", () => {
    expect(errorText(new RpcError("NotFoundError", "No thread with id t"))).toBe("No thread with id t")
  })
})
