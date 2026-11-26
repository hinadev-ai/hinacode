import { createServer, type Socket } from "node:net"
import { afterEach, expect, test, vi } from "vitest"
import { attachToRelay } from "./selfHostedRelay.ts"

const silentServers: Array<ReturnType<typeof createServer>> = []

const silentRelay = async () => {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.resume()
    socket.on("close", () => sockets.delete(socket))
  })
  silentServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  return { url: new URL(`http://127.0.0.1:${port}`), sockets }
}

afterEach(() => {
  for (const server of silentServers.splice(0)) server.close()
})

test("closing stops attach requests a relay never answered", async () => {
  const relay = await silentRelay()
  const attachment = attachToRelay(
    { url: relay.url, hostId: "machine-0123456789", token: "t", origin: { host: "127.0.0.1", port: 1 }, idle: 2 },
    () => {},
  )
  await vi.waitFor(() => expect(relay.sockets.size).toBe(2))
  attachment.close()
  await vi.waitFor(() => expect(relay.sockets.size).toBe(0))
})
