import type { PushEvent } from "@shared/contract.ts"
import { Effect } from "effect"
import { AsyncResult, AtomRegistry } from "effect/reactivity"
import { afterEach, expect, it, vi } from "vitest"
import { create } from "zustand"
import { flush } from "@/stores/testing"

const mocks = vi.hoisted(() => ({
  requests: [] as { method: string; payload: unknown; server: string | undefined }[],
  listeners: new Set<(event: unknown) => void>(),
}))

vi.mock("./connection", () => ({
  useConnection: create(() => ({ generation: 1 })),
  onEvent: (listener: (event: unknown) => void) => {
    mocks.listeners.add(listener)
    return () => mocks.listeners.delete(listener)
  },
  request: (method: string, payload: unknown, options?: { server: string }) =>
    Effect.sync(() => {
      mocks.requests.push({ method, payload, server: options?.server })
      return mocks.requests.filter((sent) => JSON.stringify(sent.payload) === JSON.stringify(payload)).length
    }),
}))

const { useConnection } = await import("./connection")
const { rpcFamily } = await import("./remote")

const filesAtom = rpcFamily("files.list", {
  refreshOn: (event, payload) => event.type === "thread.removed" && event.id === payload.threadId,
})

const read = (registry: AtomRegistry.AtomRegistry, atom: ReturnType<typeof filesAtom>) =>
  AsyncResult.getOrElse(registry.get(atom), () => null)

afterEach(() => {
  mocks.requests.length = 0
  mocks.listeners.clear()
})

it("shares one read between readers of the same payload", () => {
  const registry = AtomRegistry.make()
  registry.mount(filesAtom({ threadId: "t1" }))
  registry.mount(filesAtom({ threadId: "t1" }))
  expect(mocks.requests).toEqual([{ method: "files.list", payload: { threadId: "t1" }, server: undefined }])
})

it("sends a named server and leaves an unnamed one out", () => {
  const registry = AtomRegistry.make()
  registry.mount(filesAtom({ threadId: "t1" }, "s2"))
  registry.mount(filesAtom({ threadId: "t1" }))
  expect(mocks.requests.map((sent) => sent.server)).toEqual(["s2", undefined])
})

it("reads again after a handshake", async () => {
  const registry = AtomRegistry.make()
  const atom = filesAtom({ threadId: "t3" })
  registry.mount(atom)
  expect(read(registry, atom)).toBe(1)
  ;(useConnection as unknown as { setState: (state: object) => void }).setState({ generation: 2 })
  await flush()
  expect(read(registry, atom)).toBe(2)
})

it("reads again after a matching push and ignores others", async () => {
  const registry = AtomRegistry.make()
  const atom = filesAtom({ threadId: "t4" })
  registry.mount(atom)
  const push = (event: PushEvent) => [...mocks.listeners].forEach((listener) => listener(event))
  push({ type: "thread.removed", id: "t5" } as PushEvent)
  await flush()
  expect(read(registry, atom)).toBe(1)
  push({ type: "thread.removed", id: "t4" } as PushEvent)
  await flush()
  expect(read(registry, atom)).toBe(2)
})
