import { spawn } from "node:child_process"
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http"
import { connect, type Socket } from "node:net"
import { tailscaleAddress } from "../src/main/network.ts"

const CDP_PORT = 9334
const PUBLIC_PORT = 9333

const host = process.env["HINACODE_DEVTOOLS_HOST"] ?? tailscaleAddress()
if (!host) {
  console.error("No Tailscale address found. Set HINACODE_DEVTOOLS_HOST to the address your other device reaches.")
  process.exit(1)
}
const publicOrigin = `${host}:${PUBLIC_PORT}`

type Target = { id: string; type: string; url: string }

const appPage = async () => {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  const targets = (await response.json()) as Target[]
  return targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://"))
}

const redirectToDevtools = async (res: ServerResponse) => {
  const page = await appPage().catch(() => undefined)
  if (!page) {
    res.writeHead(503, { "content-type": "text/plain" }).end("HinaCode is still starting. Reload in a moment.")
    return
  }
  res.writeHead(302, { location: `/devtools/inspector.html?ws=${publicOrigin}/devtools/page/${page.id}` }).end()
}

const rawHead = (req: IncomingMessage) => {
  const headers = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
  return `${req.method} ${req.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`
}

const proxy = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    void redirectToDevtools(res)
    return
  }
  const upstream = request(
    { host: "127.0.0.1", port: CDP_PORT, method: req.method, path: req.url, headers: req.headers },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    },
  )
  upstream.on("error", () => res.writeHead(502).end("HinaCode is not running."))
  req.pipe(upstream)
})

proxy.on("upgrade", (req, client: Socket, head: Buffer) => {
  const upstream = connect(CDP_PORT, "127.0.0.1", () => {
    upstream.write(rawHead(req))
    upstream.write(head)
    client.pipe(upstream).pipe(client)
  })
  upstream.on("error", () => client.destroy())
  client.on("error", () => upstream.destroy())
})

const electronFlags = [
  "--ozone-platform=headless",
  "--ozone-override-screen-size=1600,1000",
  "--disable-gpu",
  `--remote-debugging-port=${CDP_PORT}`,
  `--remote-allow-origins=http://${publicOrigin}`,
]
const app = spawn("pnpm", ["dev", "--", ...electronFlags], { stdio: "inherit" })

proxy.listen(PUBLIC_PORT, host, () => console.log(`\nDevTools for HinaCode: http://${publicOrigin}\n`))

const stop = () => app.kill("SIGTERM")
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
app.on("exit", (code) => {
  proxy.close()
  process.exit(code ?? 0)
})
