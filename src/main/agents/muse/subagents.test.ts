import { describe, expect, test } from "@effect/vitest"
import type { Item } from "./protocol.ts"
import { applySubagentItem, type Subagents } from "./subagents.ts"

const itemId = "01a173d5-470c-7f41-9639-a1f1d96e7e5e"
const started: Item = {
  agentPath: "main/probe-child/1",
  controlStatus: "accepted",
  depth: 1,
  fallbackText: "Subagent: Reply with the word done.\nThen stop.",
  itemId,
  kind: "subagent",
  objective: "Reply with the word done.\nThen stop.",
  recordedAt: "2026-10-25T16:10:23.717Z",
  revision: 1,
  role: "probe-child",
  status: "inProgress",
  subagentId: "subagent-1",
  turnId: "01a173d5-46f2-7000-875b-d40acb17c6ee",
}
const usage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cachedTokens: 0,
  inputTokens: 7,
  outputTokens: 3,
  reasoningTokens: 0,
}
const running: Item = {
  ...started,
  controlStatus: "running",
  childSessionId: "01a173d5-470f-7733-a402-4f333da0ae02",
  revision: 4,
  durationMs: 17,
  usage,
}
const ready: Item = {
  ...running,
  controlStatus: "resultReady",
  revision: 5,
  result: { artifactRefs: [], evidenceRefs: [], summary: "child says done", text: "child says done" },
}
const drained: Item = { ...ready, revision: 6 }

describe("Muse sub-agents", () => {
  test("follows a subagent item from accepted to its result", () => {
    const subagents: Subagents = new Map()

    expect(applySubagentItem(subagents, started, "2026-10-25T16:10:24.000Z")).toStrictEqual({
      id: "subagent-1",
      label: "Reply with the word done.",
      callId: itemId,
      status: "running",
      summary: null,
      lastTool: null,
      toolUses: null,
      tokens: null,
      startedAt: "2026-10-25T16:10:23.717Z",
      endedAt: null,
    })
    expect(applySubagentItem(subagents, running, "2026-10-25T16:10:25.000Z")).toMatchObject({
      status: "running",
      tokens: 10,
      startedAt: "2026-10-25T16:10:23.717Z",
    })
    expect(applySubagentItem(subagents, ready, "2026-10-25T16:10:26.000Z")).toMatchObject({
      status: "completed",
      summary: "child says done",
      endedAt: "2026-10-25T16:10:26.000Z",
    })
    expect(applySubagentItem(subagents, drained, "2026-10-25T16:10:27.000Z")).toBeUndefined()
  })

  test("reads a stopped sub-agent from its cancelled result", () => {
    const subagents: Subagents = new Map()
    applySubagentItem(subagents, started, "2026-10-25T16:10:24.000Z")
    const stopped: Item = {
      ...running,
      controlStatus: "resultReady",
      revision: 5,
      result: {
        artifactRefs: [],
        evidenceRefs: [],
        errorKind: "cancelled",
        summary: "Child task cancelled: subagent attempt stopped: probe stop",
      },
    }
    expect(applySubagentItem(subagents, stopped, "2026-10-25T16:10:26.000Z")).toMatchObject({
      status: "stopped",
      summary: "Child task cancelled: subagent attempt stopped: probe stop",
      endedAt: "2026-10-25T16:10:26.000Z",
    })
  })

  test("takes a terminal item status and its failure reason over the control status", () => {
    const subagents: Subagents = new Map()
    const failed: Item = { ...running, status: "failed", failureReason: "model unavailable" }
    expect(applySubagentItem(subagents, failed, "2026-10-25T16:10:26.000Z")).toMatchObject({
      status: "failed",
      summary: "model unavailable",
      endedAt: "2026-10-25T16:10:26.000Z",
    })
  })
})
