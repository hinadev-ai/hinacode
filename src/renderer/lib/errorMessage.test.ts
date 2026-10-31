import { describe, expect, test } from "@effect/vitest"
import { errorSummary } from "./errorMessage.ts"
import { RpcError } from "./rpc.ts"

describe("errorSummary", () => {
  test("names the failed command and keeps its output as the detail", () => {
    const message =
      "git -C /tmp/repo/.worktrees/feat log --branches --remotes --tags HEAD failed: NotFound: FileSystem.access (/tmp/repo/.worktrees/feat)"
    expect(errorSummary(new RpcError({ tag: "CommandError", message }))).toStrictEqual({
      message: "The git command failed.",
      detail: message,
    })
  })

  test("has no detail for an error that is already one sentence", () => {
    expect(errorSummary(new RpcError({ tag: "FsAccessError", message: "/tmp/repo" }))).toStrictEqual({
      message: "Could not read this folder. It may have been moved or deleted.",
      detail: null,
    })
  })
})
