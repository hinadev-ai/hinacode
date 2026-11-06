import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { findGateway, gatewayModels } from "./magpie.ts"

const servers: Array<Server> = []
const configDirs: Array<string> = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(resolve))
    }),
  )
  await Promise.all(configDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const listen = async (handler: RequestListener) => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

const json =
  (body: unknown): RequestListener =>
  (_, response) =>
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))

const serve = async (routes: Record<string, RequestListener>) => {
  const authorizations: Array<string | undefined> = []
  const { port } = await listen((request, response) => {
    authorizations.push(request.headers.authorization)
    const route = routes[request.url ?? ""]
    if (!route) return response.writeHead(404).end()
    route(request, response)
  })
  return { port, authorizations }
}

const configFor = async (port: number) => {
  const dir = await mkdtemp(join(tmpdir(), "kk-magpie-"))
  configDirs.push(dir)
  await mkdir(join(dir, "magpie"))
  await writeFile(join(dir, "magpie", "settings.json"), JSON.stringify({ port }))
  return { XDG_CONFIG_HOME: dir }
}

const hello = json({ name: "magpie" })
const kimi = { id: "opencode-go/kimi-k3", display_name: "Kimi K3", reasoning_levels: ["high"], owned_by: "opencode" }

describe("findGateway and gatewayModels", () => {
  test("reach the port from settings.json and send the HinaCode key on every request", async () => {
    const { port, authorizations } = await serve({
      "/api/hello": hello,
      "/v1/models": json({ object: "list", data: [kimi, { id: "group/daily" }] }),
    })
    const env = await configFor(port)

    expect(await Effect.runPromise(findGateway(env))).toBe(`http://127.0.0.1:${port}`)
    expect(await Effect.runPromise(gatewayModels(env))).toStrictEqual([
      { id: "opencode-go/kimi-k3", display_name: "Kimi K3", reasoning_levels: ["high"] },
      { id: "group/daily" },
    ])
    expect(authorizations).toStrictEqual(Array(3).fill("Bearer magpie-hinacode"))
  })

  test("ignore a server on the port that is not magpie", async () => {
    const { port } = await serve({
      "/api/hello": json({ name: "something-else" }),
      "/v1/models": json({ data: [kimi] }),
    })
    const env = await configFor(port)

    expect(await Effect.runPromise(findGateway(env))).toBeNull()
    expect(await Effect.runPromise(gatewayModels(env))).toStrictEqual([])
  })

  test("ignore a server on the port that has no hello endpoint", async () => {
    const { port } = await serve({ "/v1/models": json({ data: [kimi] }) })
    const env = await configFor(port)

    expect(await Effect.runPromise(findGateway(env))).toBeNull()
    expect(await Effect.runPromise(gatewayModels(env))).toStrictEqual([])
  })

  test("find nothing when nothing listens on the port", async () => {
    const { server, port } = await listen(() => undefined)
    await new Promise((resolve) => server.close(resolve))
    const env = await configFor(port)

    expect(await Effect.runPromise(findGateway(env))).toBeNull()
    expect(await Effect.runPromise(gatewayModels(env))).toStrictEqual([])
  })

  test("list no models when the models body is malformed", async () => {
    const { port } = await serve({ "/api/hello": hello, "/v1/models": json({ data: [{ name: "no id" }] }) })
    const env = await configFor(port)

    expect(await Effect.runPromise(findGateway(env))).toBe(`http://127.0.0.1:${port}`)
    expect(await Effect.runPromise(gatewayModels(env))).toStrictEqual([])
  })
})
