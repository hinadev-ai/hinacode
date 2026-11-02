#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import packageJson from "../package.json" with { type: "json" }
import type { Artifact } from "./artifact.ts"
import { handleArtifactRequest } from "./http.ts"
import { type ArtifactStore, openArtifactStore } from "./store.ts"
import { registerArtifactTools } from "./tools.ts"

const USAGE = `Usage:
  hinacode-artifacts mcp                 Run the MCP server over stdio
  hinacode-artifacts serve [--port N]    Preview the artifacts on http://127.0.0.1

The store lives in $HINACODE_ARTIFACTS, or ~/.hinacode/artifacts.`

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>${body}</html>`

const listPage = (artifacts: Artifact[]) =>
  page(
    "Artifacts",
    `<body style="font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px"><h1>Artifacts</h1>${
      artifacts.length === 0
        ? "<p>No artifacts yet.</p>"
        : `<ul>${artifacts
            .map(
              (artifact) =>
                `<li><a href="/view/${artifact.id}">${escapeHtml(artifact.title)}</a> <small>v${artifact.version}, ${artifact.updatedAt}</small></li>`,
            )
            .join("")}</ul>`
    }</body>`,
  )

const viewPage = (artifact: Artifact) =>
  page(
    artifact.title,
    `<body style="margin:0;height:100vh"><iframe sandbox="allow-scripts" src="/a/${artifact.id}/${artifact.entry.split("/").map(encodeURIComponent).join("/")}" style="display:block;border:0;width:100%;height:100%"></iframe><script>
let version = ${artifact.version}
const frame = document.querySelector("iframe")
setInterval(async () => {
  const response = await fetch("/api/${artifact.id}").catch(() => null)
  if (!response?.ok) return
  const latest = await response.json()
  if (latest.version === version) return
  version = latest.version
  document.title = latest.title
  frame.src = frame.src
}, 1000)
</script></body>`,
  )

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })

const route = async (store: ArtifactStore, request: Request): Promise<Response> => {
  const url = new URL(request.url)
  if (url.pathname === "/") return html(listPage(await store.list()))
  const [, section = "", id = ""] = url.pathname.split("/")
  if (section === "a") return handleArtifactRequest(store, new Request(new URL(url.pathname.slice(2), url), request))
  const artifact = await store.get(id)
  if (!artifact) return new Response("Not found", { status: 404 })
  if (section === "view") return html(viewPage(artifact))
  if (section === "api") return Response.json(artifact, { headers: { "cache-control": "no-store" } })
  return new Response("Not found", { status: 404 })
}

const respond = async (store: ArtifactStore, incoming: IncomingMessage, outgoing: ServerResponse) => {
  const request = new Request(new URL(incoming.url ?? "/", "http://127.0.0.1"), { method: incoming.method })
  const response = await route(store, request)
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  outgoing.end(Buffer.from(await response.arrayBuffer()))
}

const serve = (store: ArtifactStore, port: number) => {
  const server = createServer((incoming, outgoing) => {
    respond(store, incoming, outgoing).catch((error: unknown) => {
      console.error(error)
      outgoing.writeHead(500).end()
    })
  })
  server.listen(port, "127.0.0.1", () => {
    const address = server.address()
    const listening = typeof address === "object" && address ? address.port : port
    console.log(`Artifacts from ${store.root} on http://127.0.0.1:${listening}`)
  })
}

const mcp = async (store: ArtifactStore) => {
  const server = new McpServer({ name: "hinacode-artifacts", version: packageJson.version })
  registerArtifactTools(server, store)
  await server.connect(new StdioServerTransport())
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string", default: "0" }, help: { type: "boolean", short: "h" } },
})
const store = openArtifactStore(process.env.HINACODE_ARTIFACTS || join(homedir(), ".hinacode", "artifacts"))
const port = Number(values.port)

if (values.help) {
  console.log(USAGE)
} else if (positionals[0] === "mcp") {
  await mcp(store)
} else if (positionals[0] === "serve" && Number.isInteger(port) && port >= 0 && port < 65536) {
  serve(store, port)
} else {
  console.error(USAGE)
  process.exitCode = 1
}
