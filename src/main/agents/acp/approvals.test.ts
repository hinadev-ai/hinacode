import { describe, expect, test } from "@effect/vitest"
import type { AccessMode } from "../../../shared/domain.ts"
import { autoAllows, mergePermissionTool, optionFor, permissionOutcome, toApprovalRequest } from "./approvals.ts"
import type { RequestPermissionParams } from "./protocol.ts"
import { makeUpdateMapper } from "./updates.ts"

const options = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
]

const FILE = "/repo/b.txt"
const DIFF = "Index: /repo/b.txt\n@@ -0,0 +1 @@\n+hi\n"

const editPermission: RequestPermissionParams = {
  sessionId: "s1",
  toolCall: {
    toolCallId: "call_1",
    title: FILE,
    kind: "edit",
    status: "pending",
    locations: [{ path: FILE }],
    rawInput: { filepath: FILE, diff: DIFF },
    content: [{ type: "diff", path: FILE, oldText: "", newText: "hi\n" }],
  },
  options,
}

describe("autoAllows", () => {
  test("lets each access mode answer what it trusts", () => {
    const kinds = ["read", "search", "fetch", "think", "edit", "execute", "delete", "move", "other", null]
    const allowed = (mode: AccessMode) => kinds.filter((kind) => autoAllows(mode, kind))
    expect(allowed("full")).toStrictEqual(kinds)
    expect(allowed("auto")).toStrictEqual(["read", "search", "fetch", "think", "edit"])
    expect(allowed("supervised")).toStrictEqual([])
  })
})

describe("optionFor", () => {
  test("maps each decision to the agent's option, with fallbacks", () => {
    expect(optionFor("allow", options)?.optionId).toBe("once")
    expect(optionFor("allow_for_session", options)?.optionId).toBe("always")
    expect(optionFor("deny", options)?.optionId).toBe("reject")
    expect(optionFor("allow_for_session", [options[0]!])?.optionId).toBe("once")
    expect(optionFor("deny", [{ optionId: "no", kind: "reject_always" }])?.optionId).toBe("no")
    expect(optionFor("deny", [options[0]!])).toBeUndefined()
  })

  test("cancels when no option fits", () => {
    expect(permissionOutcome(undefined)).toStrictEqual({ outcome: { outcome: "cancelled" } })
    expect(permissionOutcome(options[0])).toStrictEqual({ outcome: { outcome: "selected", optionId: "once" } })
  })
})

describe("toApprovalRequest", () => {
  test("shows an edit as a patch with opencode's diff", () => {
    const tool = mergePermissionTool(undefined, editPermission)
    expect(
      toApprovalRequest({ id: "a1", threadId: "t1", provider: "opencode", tool, params: editPermission }),
    ).toStrictEqual({
      id: "a1",
      threadId: "t1",
      provider: "opencode",
      kind: "patch",
      title: "Edit file",
      detail: DIFF,
      input: { filepath: FILE, diff: DIFF },
    })
  })

  test("fills a bare permission request from the tool call it already streamed", () => {
    const mapper = makeUpdateMapper("turn")
    mapper.apply({
      sessionUpdate: "tool_call",
      toolCallId: "call_2",
      title: "bash",
      kind: "execute",
      status: "pending",
    })
    mapper.apply({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_2",
      status: "in_progress",
      rawInput: { command: "rm -rf build", cwd: "/repo" },
    })
    const params: RequestPermissionParams = {
      sessionId: "s1",
      toolCall: { toolCallId: "call_2", title: "bash", kind: "execute", status: "pending", rawInput: {} },
      options,
    }
    const tool = mergePermissionTool(mapper.tool("call_2"), params)
    expect(toApprovalRequest({ id: "a2", threadId: "t1", provider: "opencode", tool, params })).toMatchObject({
      kind: "command",
      title: "Run command",
      detail: "rm -rf build",
      input: { command: "rm -rf build", cwd: "/repo" },
    })
  })
})
