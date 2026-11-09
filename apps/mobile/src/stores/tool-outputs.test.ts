import { beforeEach, describe, expect, it, vi } from "vitest"
import { flush, type PendingCall } from "./testing"

const calls = vi.hoisted((): PendingCall[] => [])
vi.mock("@/lib/connection", async () => ({ call: (await import("./testing")).fakeCall(calls) }))

const { toolOutputKey, useToolOutputs } = await import("./tool-outputs")

const state = () => useToolOutputs.getState().byCall[toolOutputKey("t1", "c1")]

beforeEach(() => {
  calls.length = 0
  useToolOutputs.setState({ byCall: {} })
})

describe("useToolOutputs", () => {
  it("asks for a call's output by thread and call id, once while it loads", async () => {
    void useToolOutputs.getState().load("t1", "c1")
    void useToolOutputs.getState().load("t1", "c1")
    expect(calls.map(({ method, payload }) => [method, payload])).toEqual([
      ["threads.toolOutput", { threadId: "t1", callId: "c1" }],
    ])
    expect(state()).toEqual({ status: "loading" })
    calls.shift()!.resolve("done\n")
    await flush()
    expect(state()).toEqual({ status: "ready", text: "done", truncated: false })
  })

  it("keeps the error so the row can offer a retry", async () => {
    void useToolOutputs.getState().load("t1", "c1")
    calls.shift()!.reject(new Error("No tool call with id c1"))
    await flush()
    expect(state()).toEqual({ status: "error", message: "No tool call with id c1" })
  })
})
