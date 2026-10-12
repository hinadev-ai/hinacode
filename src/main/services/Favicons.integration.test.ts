import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { Favicons, layer } from "./Favicons.ts"

interface Route {
  readonly type: string
  readonly body: string | Buffer
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
const png = (body: Buffer = PNG): Route => ({ type: "image/png", body })
const html = (head: string): Route => ({ type: "text/html", body: `<!doctype html><html><head>${head}</head></html>` })

const servers: Array<Server> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

/** Serves `routes` on a fresh loopback port, so every test has its own origin. Unknown paths are 404. */
const serve = async (routes: Record<string, Route>) => {
  const requests: Array<string> = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    const route = routes[request.url ?? ""]
    if (!route) return response.writeHead(404).end()
    response.writeHead(200, { "content-type": route.type }).end(route.body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

const favicon = (url: string) =>
  Effect.runPromise(Favicons.use((favicons) => favicons.favicon(url)).pipe(Effect.provide(layer)))

const dataUrl = (type: string, body: Buffer) => `data:${type};base64,${body.toString("base64")}`

describe("Favicons.favicon", () => {
  test("uses the icon a link tag points at, and asks for the origin root rather than the page", async () => {
    const { origin, requests } = await serve({
      "/": html(`<link rel="stylesheet" href="/a.css"><link rel="shortcut icon" href="/static/icon.png">`),
      "/static/icon.png": png(),
    })
    expect(await favicon(`${origin}/some/page?secret=1`)).toBe(dataUrl("image/png", PNG))
    expect(requests).toStrictEqual(["/", "/static/icon.png"])
  })

  test("resolves a relative href against the page", async () => {
    const { origin } = await serve({
      "/": html(`<link href='assets/fav.png' rel='icon'>`),
      "/assets/fav.png": png(),
    })
    expect(await favicon(origin)).toBe(dataUrl("image/png", PNG))
  })

  test("falls back to /favicon.ico without a link tag", async () => {
    const { origin } = await serve({
      "/": html("<title>none</title>"),
      "/favicon.ico": { type: "image/x-icon", body: PNG },
    })
    expect(await favicon(origin)).toBe(dataUrl("image/x-icon", PNG))
  })

  test("refuses an icon that is not an image", async () => {
    const { origin } = await serve({
      "/": html(`<link rel="icon" href="/icon">`),
      "/icon": { type: "text/html", body: "<script>alert(1)</script>" },
    })
    expect(await favicon(origin)).toBe(null)
  })

  test("refuses an icon over 100KB", async () => {
    const { origin } = await serve({ "/favicon.ico": png(Buffer.alloc(101 * 1024)) })
    expect(await favicon(origin)).toBe(null)
  })

  test("only looks up http and https", async () => {
    expect(await favicon("file:///etc/passwd")).toBe(null)
    expect(await favicon("not a url")).toBe(null)
  })

  test("asks an origin once, however many links point at it", async () => {
    const { origin, requests } = await serve({ "/favicon.ico": png() })
    const lookups = Favicons.use((favicons) =>
      Effect.gen(function* () {
        yield* Effect.all([favicons.favicon(`${origin}/a`), favicons.favicon(`${origin}/b`)], {
          concurrency: "unbounded",
        })
        return yield* favicons.favicon(`${origin}/c`)
      }),
    )
    expect(await Effect.runPromise(lookups.pipe(Effect.provide(layer)))).toBe(dataUrl("image/png", PNG))
    expect(requests).toStrictEqual(["/", "/favicon.ico"])
  })
})
