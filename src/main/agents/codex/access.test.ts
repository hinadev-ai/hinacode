import { expect, test } from "@effect/vitest"
import { threadAccess, turnAccess } from "./access.ts"
import type { SandboxPolicy } from "./protocol.ts"

const workspaceWrite: SandboxPolicy = {
  type: "workspaceWrite",
  writableRoots: ["/extra"],
  networkAccess: true,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
}

test("each access mode starts a thread with its approval policy and sandbox", () => {
  expect(threadAccess("supervised")).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write" })
  expect(threadAccess("auto")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" })
  expect(threadAccess("full")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" })
})

test("a turn keeps the thread's own workspace sandbox, so the user's sandbox config survives", () => {
  expect(turnAccess("auto", workspaceWrite)).toEqual({ approvalPolicy: "on-request" })
})

test("a turn switches the sandbox when the access mode moved past it", () => {
  expect(turnAccess("full", workspaceWrite)).toEqual({
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  })
  expect(turnAccess("supervised", { type: "dangerFullAccess" })).toMatchObject({
    approvalPolicy: "untrusted",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
  })
})
