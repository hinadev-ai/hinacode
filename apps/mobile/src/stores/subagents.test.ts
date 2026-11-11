import type { Subagent } from "@shared/agent.ts"
import { beforeEach, expect, it, vi } from "vitest"
import { flush, type PendingCall } from "./testing"

const calls = vi.hoisted((): PendingCall[] => [])
vi.mock("@/lib/connection", async () => ({
  call: (await import("./testing")).fakeCall(calls),
  onEvent: () => () => {},
  RpcError: Error,
}))

const { useSubagents } = await import("./subagents")

const subagent = (callId: string) => ({ callId }) as unknown as Subagent

beforeEach(() => {
  calls.length = 0
  useSubagents.getState().reset()
})

it("shares one request between loads of the same thread", async () => {
  const first = useSubagents.getState().load("t1")
  const second = useSubagents.getState().load("t1")
  expect(calls).toHaveLength(1)
  calls[0]!.resolve([subagent("a")])
  await Promise.all([first, second])
  expect(useSubagents.getState().byThread.t1).toEqual([subagent("a")])
})

it("asks again once the shared request has settled", async () => {
  const first = useSubagents.getState().load("t1")
  calls[0]!.resolve([])
  await first
  await flush()
  void useSubagents.getState().load("t1")
  expect(calls).toHaveLength(2)
})

it("asks again after a reset drops a request still in flight", () => {
  void useSubagents.getState().load("t1")
  useSubagents.getState().reset()
  void useSubagents.getState().load("t1")
  expect(calls).toHaveLength(2)
})
