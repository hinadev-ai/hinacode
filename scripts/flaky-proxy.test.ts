import assert from "node:assert/strict"
import { once } from "node:events"
import { request } from "node:http"
import { connect, createServer, type AddressInfo, type Socket } from "node:net"
import { mock, test } from "node:test"

const freePort = async () => {
  const server = createServer().listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo
  server.close()
  await once(server, "close")
  return port
}

test("switching from delay to pass keeps bytes in order", { timeout: 10_000 }, async (t) => {
  let delayScheduled!: (fire: () => void) => void
  const firstDelay = new Promise<() => void>((resolve) => (delayScheduled = resolve))
  mock.method(globalThis, "setTimeout", (fire: () => void, ms: number) => {
    if (ms === 500) delayScheduled(fire)
  })
  const argv = process.argv
  const signalHandlers = new Set([...process.listeners("SIGINT"), ...process.listeners("SIGTERM")])
  const sockets = new Set<Socket>()
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (signalHandlers.has(listener)) continue
        if (signal === "SIGTERM") listener(signal)
        process.off(signal, listener)
      }
    }
    upstream.close()
    process.argv = argv
    mock.restoreAll()
  })

  const expected = "first;second;"
  let received = ""
  let receivedAll!: () => void
  const allReceived = new Promise<void>((resolve) => (receivedAll = resolve))
  const upstream = createServer((socket) => {
    sockets.add(socket)
    socket.on("data", (data) => {
      received += data
      if (received.length >= expected.length) receivedAll()
    })
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const proxyPort = await freePort()
  const controlPort = await freePort()
  const post = (path: string) =>
    new Promise<boolean>((resolve) => {
      request(
        { host: "127.0.0.1", port: controlPort, path, method: "POST", agent: false, signal: t.signal },
        (response) => {
          response.resume().on("end", () => resolve(true))
        },
      )
        .on("error", () => resolve(false))
        .end()
    })

  process.argv = [
    process.argv[0]!,
    "flaky-proxy.ts",
    `${proxyPort}`,
    `${(upstream.address() as AddressInfo).port}`,
    `${controlPort}`,
  ]
  await import("./flaky-proxy.ts")

  while (!(await post("/delay?ms=500"))) t.signal.throwIfAborted()
  const client = connect(proxyPort, "127.0.0.1")
  sockets.add(client)
  await once(client, "connect")
  client.write("first;")
  const fireFirstDelay = await firstDelay
  await new Promise((resolve) => client.write("second;", resolve))
  await post("/pass")
  fireFirstDelay()
  await allReceived

  assert.equal(received, expected)
})
