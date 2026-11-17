import type { ThreadVm } from "@shared/domain.ts"
import { beforeEach, expect, it, vi } from "vitest"
import { flush, type PendingCall } from "./testing"

const calls = vi.hoisted((): PendingCall[] => [])
vi.mock("@/lib/connection", async () => ({
  call: (await import("./testing")).fakeCall(calls),
  onEvent: () => () => {},
  RpcError: Error,
}))

const { useVms } = await import("./vms")

const running: ThreadVm = {
  status: "running",
  provider: "boat",
  sandboxId: "bx_1",
  template: "default",
  profile: "off",
  control: "agent",
}

beforeEach(() => {
  calls.length = 0
  useVms.getState().reset()
})

it("keeps a pushed state over the answer of a load that started before it", async () => {
  const loading = useVms.getState().load("t1")
  useVms.getState().replace("t1", running)
  calls[0]!.resolve({ status: "none" })
  await loading
  expect(useVms.getState().byThread.t1).toEqual(running)
})

it("reloads every thread it has seen", async () => {
  useVms.getState().replace("t1", running)
  useVms.getState().replace("t2", { status: "starting" })
  useVms.getState().reload()
  await flush()
  expect(calls.map((pending) => pending.payload)).toEqual([{ threadId: "t1" }, { threadId: "t2" }])
})
