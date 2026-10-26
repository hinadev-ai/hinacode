import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { Favicons, layer } from "./Favicons.ts"

type Route = { readonly type: string; readonly body: string | Buffer } | RequestListener

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")
const SVG = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>`
const png = (body: Buffer = PNG): Route => ({ type: "image/png", body })
const html = (head: string): Route => ({ type: "text/html", body: `<!doctype html><html><head>${head}</head></html>` })
const redirect =
  (location: string): Route =>
  (_, response) =>
    response.writeHead(302, { location }).end()
/** Accepts the request and never answers. */
const hang: Route = () => undefined

const servers: Array<Server> = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(resolve))
    }),
  )
})

/** Serves `routes` on a fresh loopback port, so every test has its own origin. Unknown paths are 404. */
const serve = async (routes: Record<string, Route>) => {
  const requests: Array<string> = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    const route = routes[request.url ?? ""]
    if (!route) return response.writeHead(404).end()
    if (typeof route === "function") return route(request, response)
    response.writeHead(200, { "content-type": route.type }).end(route.body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

const favicon = (url: string) =>
  Effect.runPromise(Favicons.use((favicons) => favicons.favicon(url)).pipe(Effect.provide(layer)))

const dataUrl = (type: string, body: Buffer | string) => `data:${type};base64,${Buffer.from(body).toString("base64")}`

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
      "/favicon.ico": { type: "image/x-icon", body: GIF },
    })
    expect(await favicon(origin)).toBe(dataUrl("image/gif", GIF))
  })

  test("refuses an icon that is not an image", async () => {
    const { origin } = await serve({
      "/": html(`<link rel="icon" href="/icon">`),
      "/icon": { type: "text/html", body: "<script>alert(1)</script>" },
    })
    expect(await favicon(origin)).toBe(null)
  })

  test("refuses bytes that are no image, whatever the content type says", async () => {
    const { origin } = await serve({ "/favicon.ico": { type: "image/png", body: "<html><svg></svg></html>" } })
    expect(await favicon(origin)).toBe(null)
  })

  test("accepts an svg only when <svg> is its root element", async () => {
    const svg = await serve({ "/favicon.ico": { type: "image/svg+xml", body: SVG } })
    expect(await favicon(svg.origin)).toBe(dataUrl("image/svg+xml", SVG))
  })

  test("refuses an icon over 100KB", async () => {
    const { origin } = await serve({ "/favicon.ico": png(Buffer.concat([PNG, Buffer.alloc(100 * 1024)])) })
    expect(await favicon(origin)).toBe(null)
  })

  test("stops reading an endless icon at the cap", { timeout: 2000 }, async () => {
    const { origin } = await serve({
      "/favicon.ico": (_, response) => {
        response.writeHead(200, { "content-type": "image/png" })
        response.write(PNG)
        const pump = () => {
          while (!response.destroyed && response.write(Buffer.alloc(16 * 1024)));
        }
        response.on("drain", pump)
        pump()
      },
    })
    expect(await favicon(origin)).toBe(null)
  })

  test("follows at most 3 redirects", async () => {
    const { origin } = await serve({
      "/": html(`<link rel="icon" href="/a"><link rel="icon" href="/x">`),
      "/a": redirect("/b"),
      "/b": redirect("/c"),
      "/c": redirect("/icon.png"),
      "/icon.png": png(),
    })
    expect(await favicon(origin)).toBe(dataUrl("image/png", PNG))

    const tooMany = await serve({
      "/favicon.ico": redirect("/1"),
      "/1": redirect("/2"),
      "/2": redirect("/3"),
      "/3": redirect("/icon.png"),
      "/icon.png": png(),
    })
    expect(await favicon(tooMany.origin)).toBe(null)
    expect(tooMany.requests).not.toContain("/icon.png")
  })

  test("refuses a redirect off the web", async () => {
    const { origin } = await serve({ "/favicon.ico": redirect("file:///etc/hosts") })
    expect(await favicon(origin)).toBe(null)
  })

  test("gives up on a site within 8 seconds, however its requests stall", { timeout: 9000 }, async () => {
    const { origin } = await serve({ "/": hang, "/favicon.ico": hang })
    expect(await favicon(origin)).toBe(null)
  })

  test("only looks up http and https", async () => {
    expect(await favicon("file:///etc/passwd")).toBe(null)
    expect(await favicon("not a url")).toBe(null)
  })

  test("asks a host once, however many links and ports point at it", async () => {
    const first = await serve({ "/favicon.ico": png() })
    const second = await serve({ "/favicon.ico": { type: "image/gif", body: GIF } })
    const lookups = Favicons.use((favicons) =>
      Effect.gen(function* () {
        yield* Effect.all([favicons.favicon(`${first.origin}/a`), favicons.favicon(`${first.origin}/b`)], {
          concurrency: "unbounded",
        })
        return yield* favicons.favicon(`${second.origin}/c`)
      }),
    )
    expect(await Effect.runPromise(lookups.pipe(Effect.provide(layer)))).toBe(dataUrl("image/png", PNG))
    expect(first.requests).toStrictEqual(["/", "/favicon.ico"])
    expect(second.requests).toStrictEqual([])
  })
})
