import { WebSocketServer } from "ws"
import { attachToRelay } from "../../src/main/remote/selfHostedRelay.ts"

const port = 9000
const echo = new WebSocketServer({ port, path: "/remote", maxPayload: 64 << 20, perMessageDeflate: false })
echo.on("connection", (socket) => socket.on("message", (data, binary) => socket.send(data, { binary })))

const relayUrl = process.env["RELAY_URL"]
const url = relayUrl === undefined ? null : URL.parse(relayUrl)
if (relayUrl !== undefined && url === null) throw new Error(`RELAY_URL is not a URL: ${relayUrl}`)
if (url !== null) {
  attachToRelay(
    {
      url,
      hostId: process.env["RELAY_HOST_ID"] ?? "bench-machine-000000",
      token: process.env["HINACODE_RELAY_TOKEN"] ?? "",
      origin: { host: "127.0.0.1", port },
      idle: Number(process.env["RELAY_IDLE"] ?? 2),
    },
    (state) => console.log(JSON.stringify(state)),
  )
}
