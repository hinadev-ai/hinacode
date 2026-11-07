import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { connect, LOCAL_GATEWAY, MAGPIE_KEY, modelsOf, probe } from "./gateway.ts"

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

const serve = async (routes: Record<string, RequestListener>, requiredKey?: string) => {
  const authorizations: Array<string | undefined> = []
  const { port } = await listen((request, response) => {
    authorizations.push(request.headers.authorization)
    if (requiredKey !== undefined && request.headers.authorization !== `Bearer ${requiredKey}`)
      return response.writeHead(401).end()
    const route = routes[request.url ?? ""]
    if (!route) return response.writeHead(404).end()
    route(request, response)
  })
  return { port, origin: `http://127.0.0.1:${port}`, authorizations }
}

const configFor = async (port: number) => {
  const dir = await mkdtemp(join(tmpdir(), "kk-magpie-"))
  configDirs.push(dir)
  await mkdir(join(dir, "magpie"))
  await writeFile(join(dir, "magpie", "settings.json"), JSON.stringify({ port }))
  return { XDG_CONFIG_HOME: dir }
}

const failure = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(effect)).then((error) => error.message)

const hello = json({ name: "magpie", version: "0.1.3173" })
const kimi = { id: "opencode-go/kimi-k3", display_name: "Kimi K3", reasoning_levels: ["high"], owned_by: "opencode" }
const models = json({ object: "list", data: [kimi, { id: "group/daily" }] })

describe("the local gateway", () => {
  test("is found at the port in magpie's settings.json, with HinaCode's key on every request", async () => {
    const { port, authorizations } = await serve({ "/api/hello": hello, "/v1/models": models })
    const env = await configFor(port)

    const connection = await Effect.runPromise(connect(LOCAL_GATEWAY, env))
    expect(connection).toStrictEqual({ origin: `http://127.0.0.1:${port}`, key: MAGPIE_KEY, version: "0.1.3173" })
    expect(await Effect.runPromise(modelsOf(connection))).toStrictEqual([
      { id: "opencode-go/kimi-k3", display_name: "Kimi K3", reasoning_levels: ["high"] },
      { id: "group/daily" },
    ])
    expect(authorizations).toStrictEqual([`Bearer ${MAGPIE_KEY}`, `Bearer ${MAGPIE_KEY}`])
  })

  test("is not running when nothing on the port answers as magpie", async () => {
    const other = await serve({ "/api/hello": json({ name: "something-else" }) })
    const { server, port: closed } = await listen(() => undefined)
    await new Promise((resolve) => server.close(resolve))

    for (const port of [other.port, closed])
      expect(await failure(connect(LOCAL_GATEWAY, await configFor(port)))).toMatch(/^magpie is not running/)
  })
})

describe("a gateway at a saved endpoint", () => {
  test("is reached with the saved key on /v1/models alone, whatever the local settings say", async () => {
    const remote = await serve({ "/v1/models": models }, "sk-gateway-key")
    const env = await configFor(1)

    expect(
      await Effect.runPromise(probe({ endpoint: `${remote.origin}/v1/`, key: "sk-gateway-key" }, env)),
    ).toStrictEqual({ version: null, models: 2 })
    expect(new Set(remote.authorizations)).toStrictEqual(new Set(["Bearer sk-gateway-key"]))
  })

  test("says the key was refused when magpie answers 401", async () => {
    const remote = await serve({ "/v1/models": models }, "sk-gateway-key")

    expect(await failure(probe({ endpoint: remote.origin, key: "sk-wrong" }))).toBe(
      `${remote.origin} refused the key. Use a gateway key from magpie's Gateway keys`,
    )
    expect(await failure(probe({ endpoint: remote.origin, key: null }))).toMatch(/refused the key/)
  })

  test("says nothing answered at an address with no server", async () => {
    const { server, port } = await listen(() => undefined)
    await new Promise((resolve) => server.close(resolve))

    expect(await failure(probe({ endpoint: `http://127.0.0.1:${port}`, key: "k" }))).toBe(
      `Nothing answered at http://127.0.0.1:${port}`,
    )
  })

  test("says it cannot read a malformed model list", async () => {
    const remote = await serve({ "/v1/models": json({ data: [{ name: "no id" }] }) })

    expect(await failure(probe({ endpoint: remote.origin, key: null }))).toBe(
      `${remote.origin} sent a model list HinaCode cannot read`,
    )
  })
})
