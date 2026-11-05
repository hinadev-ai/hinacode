import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { type AddressInfo, createServer as createTcpServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"
import { preview } from "vite"
import type { RelayMachine } from "../../../../src/shared/relayMachines.ts"
import { type PairingTarget, parsePairingUrl } from "../../../../src/shared/remote.ts"

export const repoRoot = resolve(import.meta.dirname, "../../../..")
export const webBuildDir = join(repoRoot, "out/web")

export const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createTcpServer()
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      server.close(() => done(port))
    })
    server.once("error", fail)
  })

export interface Machine {
  readonly name: string
  readonly userData: string
  readonly environmentId: string
  readonly pairing: PairingTarget
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
    cwd: repoRoot,
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

const readEnvironmentId = (userData: string) => {
  const db = new DatabaseSync(join(userData, "hinacode.sqlite"), { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM setting WHERE key = 'environment.id'").get()
    if (typeof row?.["value"] !== "string") throw new Error("the machine has no environment id")
    return row["value"]
  } finally {
    db.close()
  }
}

export const startMachine = async (name: string): Promise<Machine> => {
  const userData = mkdtempSync(join(tmpdir(), "hinacode-web-e2e-"))
  const automations = { bindHost: "127.0.0.1", port: await freePort() }
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ automations }))
  const port = await freePort()
  let current = await spawnServe(userData, port)
  const running = () => current.child.exitCode === null && current.child.signalCode === null
  return {
    name,
    userData,
    environmentId: readEnvironmentId(userData),
    pairing: current.pairing,
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

export const createRepo = (path: string) => {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, "README.md"), "# web e2e\n")
  execFileSync("git", ["init", "-q", "-b", "main", path])
  execFileSync("git", ["-C", path, "add", "README.md"])
  execFileSync("git", [
    "-C",
    path,
    "-c",
    "user.email=e2e@hinacode",
    "-c",
    "user.name=e2e",
    "commit",
    "-q",
    "-m",
    "init",
  ])
  return path
}

export interface Relay {
  readonly url: string
  readonly deviceName: (credential: string) => string | undefined
  readonly signOutEveryDevice: () => void
  readonly close: () => Promise<void>
}

interface PendingSignIn {
  readonly userCode: string
  readonly name: string
  approved: boolean
}

const SIGN_IN_POLL_INTERVAL_S = 0.2
const SIGN_IN_NEVER_EXPIRES = Number.MAX_SAFE_INTEGER

const json = (response: ServerResponse, status: number, body?: unknown) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>
}

const bearer = (request: IncomingMessage) => /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1]

export const startRelay = async (machines: ReadonlyArray<RelayMachine>): Promise<Relay> => {
  const signIns = new Map<string, PendingSignIn>()
  const devices = new Map<string, string>()
  const signedIn = (request: IncomingMessage) => devices.has(bearer(request) ?? "")

  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", request.headers.origin ?? "*")
    response.setHeader("access-control-allow-headers", "authorization, content-type")
    response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE")
    response.setHeader("vary", "origin")
    if (request.method === "OPTIONS") return void response.writeHead(204).end()
    const url = new URL(request.url ?? "/", "http://relay")
    const route = `${request.method} ${url.pathname}`

    if (route === "POST /v1/sign-ins") {
      const { name } = await readJson(request)
      const deviceCode = randomBytes(16).toString("hex")
      const userCode = randomBytes(4).toString("hex").toUpperCase()
      signIns.set(deviceCode, { userCode, name: String(name), approved: false })
      const link = new URL(`/link?code=${userCode}`, `http://${request.headers.host}`)
      return json(response, 200, {
        deviceCode,
        userCode,
        url: link.href,
        interval: SIGN_IN_POLL_INTERVAL_S,
        expiresAt: SIGN_IN_NEVER_EXPIRES,
      })
    }
    if (route === "GET /link") {
      const pending = [...signIns.values()].find((signIn) => signIn.userCode === url.searchParams.get("code"))
      if (pending !== undefined) pending.approved = true
      response.writeHead(pending === undefined ? 404 : 200, { "content-type": "text/html" })
      return void response.end(pending === undefined ? "<p>Unknown code</p>" : `<p>Approved ${pending.name}</p>`)
    }
    if (route === "POST /v1/links/claim") {
      const deviceCode = String((await readJson(request)).deviceCode)
      const pending = signIns.get(deviceCode)
      if (pending === undefined) return json(response, 410, { error: "expired" })
      if (!pending.approved) return json(response, 202, { pending: true })
      signIns.delete(deviceCode)
      const credential = randomBytes(16).toString("hex")
      devices.set(credential, pending.name)
      return json(response, 200, { credential })
    }
    if (!signedIn(request)) return json(response, 401, { error: "Sign in first." })
    if (route === "GET /v1/machines") return json(response, 200, { machines })
    if (route === "GET /v1/account") return json(response, 200, { name: "Web E2E", email: "web-e2e@hinacode.test" })
    if (route === "DELETE /v1/device") {
      devices.delete(bearer(request) ?? "")
      return void response.writeHead(204).end()
    }
    json(response, 404, { error: "not found" })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    deviceName: (credential) => devices.get(credential),
    signOutEveryDevice: () => devices.clear(),
    close: () => new Promise((done) => server.close(() => done())),
  }
}

export const relayListing = (machine: Machine): RelayMachine => ({
  environmentId: machine.environmentId,
  name: machine.name,
  pairing: { ...machine.pairing, relay: "web-e2e.relay.invalid" },
})

export const serveWebApp = async () => {
  const server = await preview({
    configFile: join(repoRoot, "apps/web/vite.config.ts"),
    logLevel: "warn",
    build: { outDir: webBuildDir },
    preview: { host: "127.0.0.1", port: await freePort(), strictPort: true },
  })
  const url = server.resolvedUrls?.local[0]
  if (url === undefined) throw new Error("the web app preview server has no URL")
  return { url, close: () => server.close() }
}
