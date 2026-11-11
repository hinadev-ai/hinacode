import { AtomRegistry } from "effect/reactivity"
import { afterEach, expect, it, vi } from "vitest"
import { create } from "zustand"
import { flush, type PendingCall } from "./testing"

const calls = vi.hoisted((): PendingCall[] => [])
vi.mock("@/lib/connection", async () => ({
  call: (await import("./testing")).fakeCall(calls),
  onEvent: () => () => {},
  RpcError: Error,
  useConnection: create(() => ({ generation: 1 })),
}))

const { modelsLoadAtom, modelsOn, modelsSheetAtom, useModels } = await import("./models")

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

it("lists a provider's models again each time a model sheet opens, while the composer keeps its list mounted", async () => {
  const scheduled: Array<() => void> = []
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task)
      return () => {}
    },
  })
  registry.mount(modelsLoadAtom(undefined, "opencode"))
  await answer([])
  const unmountClosed = registry.mount(modelsSheetAtom(undefined, "opencode", false))
  expect(calls).toHaveLength(0)

  const sheetOpened = () => {
    unmountClosed()
    return registry.mount(modelsSheetAtom(undefined, "opencode", true))
  }
  const closeSheet = sheetOpened()
  expect(calls.map((pending) => pending.method)).toStrictEqual(["models.list"])
  await answer([{ id: "acme/acme-1" }])
  expect(modelsOn(useModels.getState(), undefined, "opencode")).toStrictEqual([{ id: "acme/acme-1" }])

  closeSheet()
  for (const task of scheduled.splice(0)) task()
  registry.mount(modelsSheetAtom(undefined, "opencode", true))
  expect(calls.map((pending) => pending.method)).toStrictEqual(["models.list"])
})
