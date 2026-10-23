import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const helper = fileURLToPath(new URL("./rpc.ts", import.meta.url))

test("rpc exits after printing its response without waiting for CDP to close", async () => {
  const sockets = new Set<Socket>()
  const server = createServer((_, response) => {
    const address = server.address() as AddressInfo
    response.setHeader("Content-Type", "application/json")
    response.end(
      JSON.stringify([
        { type: "page", url: "/renderer/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/page` },
      ]),
    )
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64")
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.once("data", () => {
      const payload = Buffer.from(
        JSON.stringify({ id: 1, result: { result: { value: { result: { status: "preparing" } } } } }),
      )
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const child = spawn(process.execPath, [
    helper,
    String((server.address() as AddressInfo).port),
    "threads.create",
    "{}",
  ])
  let stdout = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk
  })
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)))
  let timeout: NodeJS.Timeout | undefined
  try {
    const code = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("RPC response printed, but helper still waits for CDP close")),
          2000,
        )
      }),
    ])
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), { status: "preparing" })
  } finally {
    clearTimeout(timeout)
    child.kill()
    for (const socket of sockets) socket.destroy()
    await exited
    await new Promise((resolve) => server.close(resolve))
  }
})
