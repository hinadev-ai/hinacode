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

const setup = (otherStatus: EnvironmentStatus = "connected") => {
  const home = machine("home", {
    "threads.list": [{ id: "t-home" }],
    "projects.list": [{ id: "p-home", rootPath: "/home/p" }],
    "settings.get": { from: "home" },
  })
  const other = machine(
    "other",
    {
      "threads.list": [{ id: "t-other" }],
      "projects.list": [{ id: "p-other", rootPath: "/other/p" }],
      "threads.update": { id: "t-other" },
      "fs.list": [],
      "settings.get": { from: "other" },
    },
    otherStatus,
  )
  const route = makeRoute({
    home,
    others: new Map([[other.id, other]]),
    browser: (method) => (method === "clientSettings.get" ? Promise.resolve({ result: "browser" }) : undefined),
  })
  return { home, other, route }
}

describe("routing a web call", () => {
  it("answers client methods in the browser", async () => {
    const { home, route } = setup()
    expect(await route.call("clientSettings.get", undefined)).toEqual({ result: "browser" })
    expect(home.calls).toEqual([])
  })

  it("lists from every machine and stamps the other machine's projects", async () => {
    const { route } = setup()
    expect(await route.call("threads.list", {})).toEqual({ result: [{ id: "t-home" }, { id: "t-other" }] })
    expect(await route.call("projects.list", undefined)).toEqual({
      result: [
        { id: "p-home", rootPath: "/home/p" },
        { id: "p-other", rootPath: "/other/p", environmentId: "other" },
      ],
    })
  })

  it("sends a call about an entity to the machine that listed it", async () => {
    const { home, other, route } = setup()
    await route.call("threads.list", {})
    await route.call("projects.list", undefined)
    await route.call("threads.update", { id: "t-other", title: "x" })
    await route.call("fs.list", { root: "/other/p", path: "" })
    expect(other.calls.map((call) => call.method)).toEqual([
      "threads.list",
      "projects.list",
      "threads.update",
      "fs.list",
    ])
    await route.call("threads.update", { id: "t-home", title: "x" })
    expect(home.calls.at(-1)).toEqual({ method: "threads.update", payload: { id: "t-home", title: "x" } })
  })

  it("sends a named call to the machine it names, and to home without a name", async () => {
    const { route } = setup()
    expect(await route.call("settings.get", undefined, "other")).toEqual({ result: { from: "other" } })
    expect(await route.call("settings.get", undefined)).toEqual({ result: { from: "home" } })
    expect(await route.call("settings.get", undefined, "home")).toEqual({ result: { from: "home" } })
    expect(await route.call("settings.get", undefined, "gone")).toMatchObject({ error: { tag: "NotFoundError" } })
  })

  it("lists an offline machine's last answer instead of waiting for it", async () => {
    const { other, route } = setup("offline")
    expect(await route.call("threads.list", {})).toEqual({ result: [{ id: "t-home" }] })
    expect(other.calls).toEqual([])
  })

  it("learns owners from the other machine's pushes and stamps its artifacts", () => {
    const { route } = setup()
    const artifact = { type: "artifact.updated", artifact: { id: "a1" } } as never
    expect(route.push("other", artifact)).toMatchObject({ artifact: { id: "a1", environmentId: "other" } })
    expect(route.push("home", artifact)).toBe(artifact)
  })
})
