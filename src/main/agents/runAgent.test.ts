import { expect, test } from "@effect/vitest"
import type { Message } from "../../shared/domain.ts"
import type { ModelInfo } from "../../shared/agent.ts"
import { pickedSubagentModel, subagentChoices, spawningCallId } from "./runAgent.ts"

const assistant = (parts: Message["parts"]): Message => ({
  id: "m1",
  threadId: "t1",
  role: "assistant",
  parts,
  createdAt: "2026-10-30T00:00:00.000Z",
  completedAt: null,
  usage: null,
  forkPoint: null,
})

test("finds the running run_agent call with the same prompt on Claude and Codex", () => {
  const messages = [
    assistant([
      { type: "tool_call", callId: "done", name: "mcp__hinacode__run_agent", input: { prompt: "p" }, status: "done" },
      {
        type: "tool_call",
        callId: "other",
        name: "mcp__hinacode__run_agent",
        input: { prompt: "q" },
        status: "running",
      },
      {
        type: "tool_call",
        callId: "claude",
        name: "mcp__hinacode__run_agent",
        input: { prompt: "p" },
        status: "running",
      },
    ]),
  ]
  expect(spawningCallId(messages, "p")).toBe("claude")

  const codex = [
    assistant([
      {
        type: "tool_call",
        callId: "codex",
        name: "run_agent",
        input: { type: "mcpToolCall", server: "hinacode", tool: "run_agent", arguments: { prompt: "p" } },
        status: "running",
      },
    ]),
  ]
  expect(spawningCallId(codex, "p")).toBe("codex")
  expect(spawningCallId(codex, "missing")).toBeUndefined()
})

const pick = (fields: Partial<Parameters<typeof pickedSubagentModel>[0]>) =>
  pickedSubagentModel({ agent: "opencode", requested: undefined, threadModel: null, picked: [], listed: [], ...fields })

test("refuses every model when nothing is picked or listed", () => {
  expect(pick({}).kind).toBe("refused")
  expect(pick({ requested: "openrouter/a" }).kind).toBe("refused")
})

const thirty = Array.from({ length: 30 }, (_, index) => `vendor/model-${index}`)

test("accepts any listed model when the user picked none, beyond the 20 offered", () => {
  expect(pick({ listed: thirty })).toStrictEqual({ kind: "chosen", model: "vendor/model-0" })
  expect(pick({ listed: thirty, requested: "vendor/model-27" })).toStrictEqual({
    kind: "chosen",
    model: "vendor/model-27",
  })
})

test("suggests similar listed ids for a model the provider does not list", () => {
  expect(pick({ listed: [...thirty, "other/kimi-k3"], requested: "kimi-k2" })).toStrictEqual({
    kind: "refused",
    message: "opencode does not list kimi-k2. Similar ids: other/kimi-k3.",
  })
})

test("keeps a user's picks as the only choices", () => {
  expect(pick({ listed: thirty, picked: ["vendor/model-1"], requested: "vendor/model-27" }).kind).toBe("refused")
})

test("defaults to the calling thread's own model, then the first picked one", () => {
  expect(pick({ picked: ["a", "b"] })).toStrictEqual({ kind: "chosen", model: "a" })
  expect(pick({ picked: ["a", "b"], threadModel: "t" })).toStrictEqual({ kind: "chosen", model: "t" })
  expect(pick({ threadModel: "t" })).toStrictEqual({ kind: "chosen", model: "t" })
})

test("lists the allowed models once when the requested one is not among them", () => {
  expect(pick({ picked: ["a", "t"], threadModel: "t", requested: "z" })).toStrictEqual({
    kind: "refused",
    message: "z is not among the opencode models the user picked. Use one of: t, a.",
  })
})

const modelOf = (id: string): ModelInfo => ({
  id,
  label: id,
  provider: "magpie",
  efforts: [],
  defaultEffort: null,
  fastMode: false,
  autoMode: false,
})
const listing = Array.from({ length: 30 }, (_, index) => modelOf(`m${index}`))
const noPresets = { claude: [], codex: [], muse: [], opencode: [], magpie: [] }

test("offers the first 20 listed models of magpie and opencode until the user picks some", () => {
  const choices = subagentChoices(
    { claude: null, codex: null, muse: null, opencode: listing, magpie: listing },
    { ...noPresets, magpie: ["m25"] },
    ["opencode", "magpie"],
  )
  expect(choices.map((choice) => [choice.provider, choice.models.length, choice.hidden])).toStrictEqual([
    ["opencode", 20, 10],
    ["magpie", 1, 0],
  ])
})

test("leaves disabled providers out of the choices", () => {
  const choices = subagentChoices(
    { claude: [modelOf("c")], codex: [modelOf("x")], muse: null, opencode: listing, magpie: null },
    noPresets,
    ["codex"],
  )
  expect(choices.map((choice) => choice.provider)).toStrictEqual(["codex"])
})
