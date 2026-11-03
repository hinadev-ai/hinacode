import { describe, expect, it } from "vitest"
import type { RpcEnvelope, RpcMethod } from "../../../src/shared/contract.ts"
import type { EnvironmentStatus } from "../../../src/shared/domain.ts"
import { makeRoute, type MachineLink } from "./route.ts"

const machine = (
  id: string,
  answers: Partial<Record<RpcMethod, unknown>>,
  status: EnvironmentStatus = "connected",
): MachineLink & { readonly calls: Array<{ method: RpcMethod; payload: unknown }> } => {
  const calls: Array<{ method: RpcMethod; payload: unknown }> = []
  return {
    id,
    name: `${id} name`,
    calls,
    status: () => status,
    call: async (method, payload): Promise<RpcEnvelope<unknown>> => {
      calls.push({ method, payload })
      return method in answers ? { result: answers[method] } : { error: { tag: "Missing", message: method } }
    },
  }
}

const setup = (firstStatus: EnvironmentStatus = "connected") => {
  const first = machine(
    "first",
    {
      "threads.list": [{ id: "t-first" }],
      "projects.list": [{ id: "p-first", rootPath: "/first/p" }],
      "threads.update": { id: "t-first" },
      "settings.get": { from: "first" },
    },
    firstStatus,
  )
  const second = machine("second", {
    "threads.list": [{ id: "t-second" }],
    "projects.list": [{ id: "p-second", rootPath: "/second/p" }],
    "threads.update": { id: "t-second" },
    "fs.list": [],
    "settings.get": { from: "second" },
  })
  const route = makeRoute({
    machines: new Map([
      [first.id, first],
      [second.id, second],
    ]),
    browser: (method) => (method === "clientSettings.get" ? Promise.resolve({ result: "browser" }) : undefined),
  })
  return { first, second, route }
}

describe("routing a web call", () => {
  it("answers client methods in the browser", async () => {
    const { first, second, route } = setup()
    expect(await route.call("clientSettings.get", undefined)).toEqual({ result: "browser" })
    expect([...first.calls, ...second.calls]).toEqual([])
  })

  it("lists from every machine and stamps each machine's projects", async () => {
    const { route } = setup()
    expect(await route.call("threads.list", {})).toEqual({ result: [{ id: "t-first" }, { id: "t-second" }] })
    expect(await route.call("projects.list", undefined)).toEqual({
      result: [
        { id: "p-first", rootPath: "/first/p", environmentId: "first" },
        { id: "p-second", rootPath: "/second/p", environmentId: "second" },
      ],
    })
  })

  it("sends a call about an entity to the machine that listed it", async () => {
    const { first, second, route } = setup()
    await route.call("threads.list", {})
    await route.call("projects.list", undefined)
    await route.call("threads.update", { id: "t-second", title: "x" })
    await route.call("fs.list", { root: "/second/p", path: "" })
    expect(second.calls.map((call) => call.method)).toEqual([
      "threads.list",
      "projects.list",
      "threads.update",
      "fs.list",
    ])
    await route.call("threads.update", { id: "t-first", title: "x" })
    expect(first.calls.at(-1)).toEqual({ method: "threads.update", payload: { id: "t-first", title: "x" } })
  })

  it("sends a named call to the machine it names", async () => {
    const { route } = setup()
    expect(await route.call("settings.get", undefined, "second")).toEqual({ result: { from: "second" } })
    expect(await route.call("settings.get", undefined, "gone")).toMatchObject({ error: { tag: "NotFoundError" } })
  })

  it("sends a call that names no machine to the first connected one", async () => {
    expect(await setup().route.call("settings.get", undefined)).toEqual({ result: { from: "first" } })
    expect(await setup("offline").route.call("settings.get", undefined)).toEqual({ result: { from: "second" } })
  })

  it("lists an offline machine's last answer instead of waiting for it", async () => {
    const { first, route } = setup("offline")
    expect(await route.call("threads.list", {})).toEqual({ result: [{ id: "t-second" }] })
    expect(first.calls).toEqual([])
  })

  it("learns owners from pushes and stamps artifacts with their machine", () => {
    const { route } = setup()
    const artifact = { type: "artifact.updated", artifact: { id: "a1" } } as never
    expect(route.push("second", artifact)).toMatchObject({ artifact: { id: "a1", environmentId: "second" } })
  })
})
