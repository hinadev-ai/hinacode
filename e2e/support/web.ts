import { type ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"
import { preview } from "vite"
import type { RelayMachine } from "../../src/shared/relayMachines.ts"
import { type PairingTarget, parsePairingUrl } from "../../src/shared/remote.ts"
import { freePort, projectRoot } from "./app.ts"
import { Seed } from "./seed.ts"

export const WEB_APP_DIR = join(projectRoot, "out/web")

export interface Machine {
  readonly name: string
  readonly userData: string
  readonly seed: Seed
  readonly environmentId: string
  readonly pairing: PairingTarget
  readonly running: () => boolean
  readonly start: () => Promise<void>
  readonly stop: () => Promise<void>
}

const serveEnv = (userData: string) => ({
  ...process.env,
  HINACODE_USER_DATA: userData,
  HINACODE_SERVE_AUTO_UPDATE: "0",
  HINACODE_SKIP_AGENT_UPDATES: "1",
  HINACODE_MOCK_AGENTS: "markdown",
})

const spawnServe = async (userData: string, port: number) => {
  const child = spawn(process.execPath, ["bin/hinacode.mjs", "serve", "--port", String(port), "--host", "127.0.0.1"], {
    cwd: projectRoot,
    env: serveEnv(userData),
    stdio: ["ignore", "pipe", "pipe"],
  })
  const output: Array<string> = []
  const pairing = new Promise<PairingTarget>((done, fail) => {
    const read = (line: string) => {
      output.push(line)
      const target = parsePairingUrl(line)
      if (target !== null) done(target)
    }
    if (child.stdout) createInterface({ input: child.stdout }).on("line", read)
    if (child.stderr) createInterface({ input: child.stderr }).on("line", read)
    child.once("exit", (code) => fail(new Error(`hinacode serve exited with ${code}:\n${output.join("\n")}`)))
  })
  return { child, pairing: await pairing }
}

const stopServe = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  await exited
}

const readEnvironmentId = (dbPath: string) => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM setting WHERE key = 'environment.id'").get()
    if (typeof row?.["value"] !== "string") throw new Error("the machine has no environment id")
    return row["value"]
  } finally {
    db.close()
  }
}

export const startMachine = async (name: string): Promise<Machine> => {
  const userData = mkdtempSync(join(tmpdir(), "kk-e2e-web-"))
  const seed = new Seed(join(userData, "hinacode.sqlite"))
  seed.setting("automations", { bindHost: "127.0.0.1", port: await freePort() })
  const port = await freePort()
  let current = await spawnServe(userData, port)
  const running = () => current.child.exitCode === null && current.child.signalCode === null
  return {
    name,
    userData,
    seed,
    environmentId: readEnvironmentId(join(userData, "hinacode.sqlite")),
    pairing: current.pairing,
    running,
    start: async () => {
      if (!running()) current = await spawnServe(userData, port)
    },
    stop: () => stopServe(current.child),
  }
}

export const closeMachine = async (machine: Machine) => {
  await machine.stop()
  rmSync(machine.userData, { recursive: true, force: true })
}

export interface Relay {
  readonly url: string
  readonly ownerToken: string
  readonly close: () => Promise<void>
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const answerRelay =
  (machines: ReadonlyArray<RelayMachine>, ownerToken: string) =>
  (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("access-control-allow-origin", request.headers.origin ?? "*")
    response.setHeader("access-control-allow-headers", "authorization")
    response.setHeader("vary", "origin")
    if (request.method === "OPTIONS") return void response.writeHead(204).end()
    if (request.method !== "GET" || request.url !== "/v1/machines") return json(response, 404, { error: "not found" })
    if (request.headers.authorization !== `Bearer ${ownerToken}`) return json(response, 401, { error: "unauthorized" })
    json(response, 200, { machines })
  }

export const startRelay = async (machines: ReadonlyArray<RelayMachine>, ownerToken: string): Promise<Relay> => {
  const server = createServer(answerRelay(machines, ownerToken))
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("the relay stub has no port")
  return {
    url: `http://127.0.0.1:${address.port}`,
    ownerToken,
    close: () => new Promise((done) => server.close(() => done())),
  }
}

export const relayListing = (machine: Machine): RelayMachine => ({
  environmentId: machine.environmentId,
  name: machine.name,
  pairing: { ...machine.pairing, relay: "e2e-machine.relay.invalid" },
})

export const serveWebApp = async () => {
  const server = await preview({
    configFile: join(projectRoot, "apps/web/vite.config.ts"),
    logLevel: "warn",
    build: { outDir: WEB_APP_DIR },
    preview: { host: "127.0.0.1", port: await freePort(), strictPort: true },
  })
  const url = server.resolvedUrls?.local[0]
  if (url === undefined) throw new Error("the web app preview server has no URL")
  return { url, close: () => server.close() }
}
