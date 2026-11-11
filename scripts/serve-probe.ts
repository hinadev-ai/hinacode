import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"

const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === "object" && address !== null ? resolvePort(address.port) : reject(new Error("no port")),
      )
    })
  })

export const withServe = async (
  command: ReadonlyArray<string>,
  dataDir: string,
  check: (port: number) => Promise<void>,
) => {
  const [file, ...args] = command
  assert.ok(file !== undefined, "serve needs a command")
  const port = await freePort()
  const child = spawn(file, [...args, "serve", "--host", "127.0.0.1", "--port", String(port), "--relay", "off"], {
    env: { ...process.env, HINACODE_USER_DATA: dataDir, HINACODE_SERVE_AUTO_UPDATE: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()))
  const exited = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)))

  try {
    await new Promise<void>((resolveBoot, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`serve did not print its pairing block in 30s:\n${output}`)),
        30_000,
      )
      child.stdout.on("data", () => {
        if (output.includes("Pair a phone")) {
          clearTimeout(deadline)
          resolveBoot()
        }
      })
      void exited.then((code) => {
        clearTimeout(deadline)
        reject(new Error(`serve exited with ${code} before boot:\n${output}`))
      })
    })
  } catch (error) {
    child.kill("SIGTERM")
    throw error
  }

  try {
    await check(port)
  } finally {
    child.kill("SIGTERM")
    await exited
  }
  return { port, exitCode: await exited }
}
