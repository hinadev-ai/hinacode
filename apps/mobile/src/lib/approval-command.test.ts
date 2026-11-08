import type { ApprovalRequest } from "@shared/agent.ts"
import { expect, it } from "vitest"
import { approvalCommand } from "./approval-command"

const request = (fields: Partial<ApprovalRequest>): ApprovalRequest => ({
  id: "r",
  threadId: "t",
  provider: "claude",
  kind: "command",
  title: "Bash",
  detail: "",
  ...fields,
})

it("reads Claude's command from the session scope and keeps its description as the note", () => {
  expect(
    approvalCommand(
      request({
        detail: "Add @boat/sdk package with pnpm",
        input: { command: "pnpm add @boat/sdk" },
        sessionScope: { tool: "Bash", kind: "command", value: "pnpm add @boat/sdk" },
      }),
    ),
  ).toEqual({ command: "pnpm add @boat/sdk", note: "Add @boat/sdk package with pnpm" })
})

it("falls back to the input command, then to the detail an ACP agent sends", () => {
  expect(approvalCommand(request({ detail: "Install", input: { command: "pnpm i" } }))).toEqual({
    command: "pnpm i",
    note: "Install",
  })
  expect(approvalCommand(request({ provider: "opencode", title: "Run command", detail: "ls -la" }))).toEqual({
    command: "ls -la",
    note: "",
  })
})
