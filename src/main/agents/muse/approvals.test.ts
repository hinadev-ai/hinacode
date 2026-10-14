import { describe, expect, test } from "@effect/vitest"
import { choiceFor, sessionScope, toApprovalRequest } from "./approvals.ts"
import type { ApprovalChoice, ApprovalRequestParams } from "./protocol.ts"

// Choices and subjects from muse 1.4.7 under `promptUnmatched`.
const shellChoices: Array<ApprovalChoice> = [
  { choiceId: "allow_once", decision: "approved", scope: "once", label: "Allow once" },
  {
    choiceId: "allow_local_prefix",
    decision: "approvedPolicyAmendment",
    scope: "localPersistent",
    label: "Always allow in this workspace: ls ...",
  },
  { choiceId: "abort", decision: "abort", scope: "once", label: "Reject", acceptsFeedback: true },
]
const networkChoices: Array<ApprovalChoice> = [
  { choiceId: "allow_once", decision: "approved", scope: "once", label: "Allow once" },
  { choiceId: "allow_session", decision: "approvedForSession", scope: "session", label: "Allow for this session" },
  { choiceId: "deny_once", decision: "denied", scope: "once", label: "Deny" },
  { choiceId: "abort", decision: "abort", scope: "once", label: "Reject", acceptsFeedback: true },
]

const request = (fields: Partial<ApprovalRequestParams>) =>
  ({
    approvalId: "0199a8f0-0000-7000-8000-00000000000a",
    availableChoices: shellChoices,
    currentRequirementId: { approvalId: "0199a8f0-0000-7000-8000-00000000000a", sourceIndex: 0 },
    itemId: "0199a8f0-0000-7000-8000-000000000001",
    judgeEscalated: false,
    protectedWrite: false,
    rawArgs: '{"command":"ls -la && echo hi","description":"List the workspace"}',
    sessionId: "0199a8f0-0000-7000-8000-0000000000ss",
    subject: { kind: "shell", command: "ls -la && echo hi", stages: [] },
    taskId: "0199a8f0-0000-7000-8000-000000000001",
    toolCallId: "call_1",
    toolName: "bash",
    turnId: "0199a8f0-0000-7000-8000-0000000000tt",
    viewCursor: "c1",
    ...fields,
  }) as ApprovalRequestParams

describe("choiceFor", () => {
  test("allows once and never widens into a workspace rule", () => {
    expect(choiceFor("allow", shellChoices)?.choiceId).toBe("allow_once")
    expect(choiceFor("allow", [shellChoices[1]!, shellChoices[2]!])).toBeUndefined()
  })

  test("allows for the session where Muse offers it, else once", () => {
    expect(choiceFor("allow_for_session", networkChoices)?.choiceId).toBe("allow_session")
    expect(choiceFor("allow_for_session", shellChoices)?.choiceId).toBe("allow_once")
  })

  test("denies, else rejects", () => {
    expect(choiceFor("deny", networkChoices)?.choiceId).toBe("deny_once")
    expect(choiceFor("deny", shellChoices)?.choiceId).toBe("abort")
  })
})

describe("sessionScope", () => {
  test("covers the exact shell command", () => {
    expect(sessionScope(request({}))).toStrictEqual({ tool: "Bash", kind: "command", value: "ls -la && echo hi" })
  })

  test("covers the file or host Muse asked about", () => {
    expect(
      sessionScope(request({ toolName: "write_file", subject: { kind: "fileAccess", access: "write", path: "/x" } })),
    ).toStrictEqual({ tool: "Write", kind: "path", value: "/x" })
    expect(
      sessionScope(
        request({
          subject: { kind: "network", host: "example.com", port: 443, protocol: "https", toolName: "network" },
        }),
      ),
    ).toStrictEqual({ tool: "network", kind: "domain", value: "example.com" })
  })

  test("covers every call of a tool when the subject names nothing narrower", () => {
    expect(sessionScope(request({ toolName: "web_fetch", subject: { kind: "tool" } }))).toStrictEqual({
      tool: "WebFetch",
      kind: "tool",
      value: "WebFetch",
    })
  })
})

describe("toApprovalRequest", () => {
  test("titles a shell approval with the model's description and shows the whole command", () => {
    expect(toApprovalRequest(request({}), "approval-1", "thread-1")).toStrictEqual({
      id: "approval-1",
      threadId: "thread-1",
      provider: "muse",
      kind: "command",
      title: "List the workspace",
      detail: "ls -la && echo hi",
      input: { command: "ls -la && echo hi", description: "List the workspace" },
      sessionScope: { tool: "Bash", kind: "command", value: "ls -la && echo hi" },
    })
  })

  test("titles a shell approval without a description generically", () => {
    expect(toApprovalRequest(request({ rawArgs: '{"command":"ls"}' }), "a", "t").title).toBe("Run command")
  })

  test("describes a network approval by protocol, host and port", () => {
    const network = request({
      availableChoices: networkChoices,
      rawArgs: '{"command":"curl https://example.com"}',
      subject: {
        kind: "network",
        host: "example.com",
        port: 443,
        protocol: "https",
        toolName: "network",
        origin: { kind: "shellCommand", command: "curl https://example.com" },
      },
    })
    expect(toApprovalRequest(network, "a", "t")).toMatchObject({
      kind: "tool",
      title: "Network access",
      detail: "https example.com 443",
    })
  })

  test("asks to read or write a file as a tool call or a patch", () => {
    const read = request({ toolName: "read_file", subject: { kind: "fileAccess", access: "read", path: "/etc/hosts" } })
    expect(toApprovalRequest(read, "a", "t")).toMatchObject({ kind: "tool", title: "Read file", detail: "/etc/hosts" })
    const write = request({ toolName: "write_file", subject: { kind: "fileAccess", access: "write", path: "/x" } })
    expect(toApprovalRequest(write, "a", "t")).toMatchObject({ kind: "patch", title: "Write file", detail: "/x" })
  })

  test("names an unknown subject by its tool and shows the raw arguments", () => {
    const other = request({ toolName: "web_fetch", rawArgs: '{"url":"https://x"}', subject: { kind: "unixSocket" } })
    expect(toApprovalRequest(other, "a", "t")).toMatchObject({
      kind: "tool",
      title: "WebFetch",
      detail: '{"url":"https://x"}',
    })
  })
})
