import assert from "node:assert/strict"
import { once } from "node:events"
import { request } from "node:http"
import { connect, createServer } from "node:net"
import { mock, test } from "node:test"
import { setImmediate as nextTurn } from "node:timers/promises"

// Run with `node --test scripts/flaky-proxy.test.mjs`. Vitest only collects tests under src/.

const until = async (condition, signal) => {
  while (!signal.aborted) {
    if (await condition()) return
    await nextTurn()
  }
  signal.throwIfAborted()
}

const freePort = async () => {
  const server = createServer().listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address()
  server.close()
  await once(server, "close")
  return port
}

test("switching from delay to pass keeps bytes in order", { timeout: 10_000 }, async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] })
  const timeouts = mock.method(globalThis, "setTimeout")
  const argv = process.argv
  const signalHandlers = new Set([...process.listeners("SIGINT"), ...process.listeners("SIGTERM")])
  const sockets = new Set()
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (signalHandlers.has(listener)) continue
        // The proxy's own shutdown handler resets its sockets and closes its servers.
        if (signal === "SIGTERM") listener()
        process.off(signal, listener)
      }
    }
    upstream.close()
    process.argv = argv
    mock.restoreAll()
    mock.timers.reset()
  })

  let received = ""
  const upstream = createServer((socket) => {
    sockets.add(socket)
    socket.on("data", (data) => (received += data))
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const proxyPort = await freePort()
  const controlPort = await freePort()
  const post = (path) =>
    new Promise((resolve) => {
      request(
        { host: "127.0.0.1", port: controlPort, path, method: "POST", agent: false, signal: t.signal },
        (response) => {
          response.resume().on("end", () => resolve(true))
        },
      )
        .on("error", () => resolve(false))
        .end()
    })

  process.argv = [process.argv[0], "flaky-proxy.mjs", `${proxyPort}`, `${upstream.address().port}`, `${controlPort}`]
  await import("./flaky-proxy.mjs")

  await until(() => post("/delay?ms=500"), t.signal)
  const client = connect(proxyPort, "127.0.0.1")
  sockets.add(client)
  await once(client, "connect")
  client.write("first;")
  await until(() => timeouts.mock.calls.some((call) => call.arguments[1] === 500), t.signal)
  await new Promise((resolve) => client.write("second;", resolve))
  await post("/pass")
  mock.timers.tick(500)
  await until(() => received.length === "first;second;".length, t.signal)

  assert.equal(received, "first;second;")
})
