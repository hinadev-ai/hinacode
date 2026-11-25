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

const unreadable = ["/home/u/.hinacode/hinacode.sqlite*", "/home/u/.hinacode/scratch/other-thread/**"]

const profileOf = (access: ReturnType<typeof threadAccess>) => access.config?.permissions.hinacode

test("full access starts a thread without a sandbox and keeps no permission profile", () => {
  expect(threadAccess("full", unreadable, null)).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" })
})

test("a sandboxed thread starts on HinaCode's profile, which denies reading other threads' secrets", () => {
  for (const [mode, approvalPolicy] of [
    ["supervised", "untrusted"],
    ["auto", "on-request"],
  ] as const) {
    expect(threadAccess(mode, unreadable, null)).toEqual({
      approvalPolicy,
      config: {
        default_permissions: "hinacode",
        permissions: {
          hinacode: {
            extends: ":workspace",
            filesystem: {
              "/home/u/.hinacode/hinacode.sqlite*": "deny",
              "/home/u/.hinacode/scratch/other-thread/**": "deny",
            },
          },
        },
      },
    })
  }
})

test("the profile keeps the network access and writable roots the user gave the workspace sandbox", () => {
  const userSandbox = { sandbox_workspace_write: { writable_roots: ["/extra"], network_access: true } }
  expect(profileOf(threadAccess("auto", unreadable, userSandbox))).toEqual({
    extends: ":workspace",
    network: { enabled: true },
    filesystem: {
      "/extra": "write",
      "/home/u/.hinacode/hinacode.sqlite*": "deny",
      "/home/u/.hinacode/scratch/other-thread/**": "deny",
    },
  })
})

test("the profile builds on the user's own default permission profile", () => {
  const userSandbox = {
    default_permissions: "mine",
    sandbox_workspace_write: { writable_roots: ["/extra"], network_access: true },
  }
  expect(profileOf(threadAccess("supervised", unreadable, userSandbox))).toEqual({
    extends: "mine",
    filesystem: {
      "/home/u/.hinacode/hinacode.sqlite*": "deny",
      "/home/u/.hinacode/scratch/other-thread/**": "deny",
    },
  })
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
