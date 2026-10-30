import { describe, expect, test } from "@effect/vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ApprovalRequest } from "../../shared/agent.ts"
import { ApprovalCard } from "./ApprovalCard.tsx"

describe("approval card", () => {
  test("offers a note for the agent beside the three decisions", () => {
    const request: ApprovalRequest = {
      id: "request",
      threadId: "thread",
      provider: "claude",
      kind: "command",
      title: "Run command",
      detail: "npm test",
    }
    const html = renderToStaticMarkup(createElement(ApprovalCard, { request, providerLabel: "Claude Code" }))
    expect(html).toContain('aria-label="Note for the agent"')
    for (const label of ["Allow", "Allow for session", "Deny"]) expect(html).toContain(`>${label}</button>`)
  })
})
