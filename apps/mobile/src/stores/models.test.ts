import { afterEach, expect, it, vi } from "vitest"
import { flush, type PendingCall } from "./testing"

const calls = vi.hoisted((): PendingCall[] => [])
vi.mock("@/lib/connection", async () => ({
  call: (await import("./testing")).fakeCall(calls),
  onEvent: () => () => {},
  RpcError: Error,
}))

const { modelsOn, useModels } = await import("./models")

const answer = async (models: unknown) => {
  for (const pending of calls) pending.resolve(models)
  calls.length = 0
  await flush()
}

afterEach(() => {
  calls.length = 0
  useModels.setState({ byServer: {} })
})

it("keeps a provider's stored list for the settings rows, and lists it again when forced", async () => {
  const first = useModels.getState().load(undefined, "opencode")
  await answer([])
  await first
  await useModels.getState().load(undefined, "opencode")
  expect(calls).toHaveLength(0)

  const forced = useModels.getState().load(undefined, "opencode", { force: true })
  expect(calls.map((pending) => pending.method)).toStrictEqual(["models.list"])
  await answer([{ id: "acme/acme-1" }])
  await forced
  expect(modelsOn(useModels.getState(), undefined, "opencode")).toStrictEqual([{ id: "acme/acme-1" }])
})
