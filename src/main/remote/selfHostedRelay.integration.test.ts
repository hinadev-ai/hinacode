import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import type { RelayStatus } from "../../shared/domain.ts"
import { relayWebSocketUrl } from "../../shared/remote.ts"
import { unlistedModel } from "../../shared/agent.ts"
import { AppConnections } from "../apps/AppConnections.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import { PiProvider } from "../agents/pi/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import { Settings } from "../services/Settings.ts"
import { makeTestAppLayer } from "../testing.ts"
import { RemoteAccess } from "./access.ts"
import { Relay } from "./relay.ts"
import { remoteClient, unusedLoopbackPort } from "./testing.ts"

vi.mock("electron", () => ({
  Notification: EventTarget,
  app: { getPath: () => "", focus: () => {} },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const TOKEN = "relay-token-for-the-integration-test-0123456789"

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: () => Stream.empty,
  steer: () => Effect.succeed(true),
  interrupt: () => Effect.void,
  respondApproval: () => Effect.succeed(false),
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const providers = Layer.mergeAll(
  Layer.succeed(ClaudeProvider, provider("claude")),
  Layer.succeed(CodexProvider, provider("codex")),
  Layer.succeed(MuseProvider, provider("muse")),
  Layer.succeed(OpencodeProvider, provider("opencode")),
  Layer.succeed(MagpieProvider, provider("magpie")),
  Layer.succeed(PiProvider, provider("pi")),
)

let dir = ""
let relayd: ChildProcess
let relayUrl = ""
let machine: ManagedRuntime.ManagedRuntime<AppConnections | Relay | RemoteAccess | Settings, unknown>

const relayStatus = (predicate: (status: RelayStatus) => boolean) =>
  machine.runPromise(
    Relay.use((relay) =>
      Stream.merge(Stream.fromEffect(relay.status), relay.changes).pipe(Stream.filter(predicate), Stream.runHead),
    ),
  )

const startRelayd = async () => {
  const binary = join(dir, "hinacode-relayd")
  execFileSync("go", ["build", "-o", binary, "."], { cwd: join(import.meta.dirname, "../../../relayd") })
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=relay",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  )
  setDefaultCACertificates([...getCACertificates("default"), readFileSync(join(dir, "cert.pem"), "utf8")])
  const port = await unusedLoopbackPort()
  relayUrl = `https://127.0.0.1:${port}`
  relayd = spawn(
    binary,
    ["-listen", `127.0.0.1:${port}`, "-tls-cert", join(dir, "cert.pem"), "-tls-key", join(dir, "key.pem")],
    {
      env: { ...process.env, HINACODE_RELAY_TOKEN: TOKEN },
      stdio: "ignore",
    },
  )
  await vi.waitFor(async () => expect((await fetch(`${relayUrl}/healthz`)).status).toBe(200), { timeout: 10_000 })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kk-self-hosted-relay-"))
  await startRelayd()
  machine = ManagedRuntime.make(makeTestAppLayer(join(dir, "hinacode.sqlite"), { providers }))
  const port = await unusedLoopbackPort()
  await machine.runPromise(
    Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port } })),
  )
  await vi.waitFor(async () =>
    expect((await machine.runPromise(RemoteAccess.use((access) => access.status))).listening).toBe(true),
  )
}, 120_000)

afterAll(async () => {
  await machine?.dispose()
  relayd?.kill()
  rmSync(dir, { recursive: true, force: true })
})

test("a phone completes an encrypted session with the machine through the self-hosted relay", async () => {
  await machine.runPromise(Relay.use((relay) => relay.useSelfHosted({ url: `${relayUrl}/`, token: TOKEN })))
  await relayStatus((status) => status.state === "connected")

  const { relay, key, secret } = await machine.runPromise(RemoteAccess.use((access) => access.pairing))
  const { id } = await machine.runPromise(RemoteAccess.use((access) => Effect.succeed(access.identity)))
  expect(relay).toBe(`127.0.0.1:${new URL(relayUrl).port}/h/${id}`)

  const phone = remoteClient(new URL(relayWebSocketUrl(relay!)), key)
  await phone.hello({ name: "phone", secret })
  expect(await phone.ready()).toMatchObject({ type: "ready", relay })
  phone.socket.close()

  const apps = await machine.runPromise(AppConnections.use((connections) => connections.status))
  expect(apps.url).toBeNull()
})

test("a wrong token leaves the machine unreachable and says why", async () => {
  await machine.runPromise(Relay.use((relay) => relay.useSelfHosted({ url: relayUrl, token: `${TOKEN}-wrong` })))
  const refused = await relayStatus((status) => status.state === "connecting" && status.error !== null)
  expect(refused).toMatchObject({ _tag: "Some", value: { error: "The relay refused this machine's token." } })
})

test.each([
  ["a port out of range", "https://relay.example.com:99999"],
  ["an address that is not an IP or a name", "https://999.999.999.999"],
  ["a name that pairing URLs cannot carry", "https://relay:8443"],
  ["a path", "https://relay.example.com/relay"],
])("refuses a relay URL with %s and keeps the setting", async (_, url) => {
  const before = await machine.runPromise(Settings.use((settings) => settings.get))
  const refused = await machine.runPromise(
    Relay.use((relay) => relay.useSelfHosted({ url, token: TOKEN })).pipe(Effect.flip),
  )
  expect(refused.message).toBe("Enter the relay as https://host or https://host:port.")
  const after = await machine.runPromise(Settings.use((settings) => settings.get))
  expect(after.selfHostedRelay).toBe(before.selfHostedRelay)
})

test("stopping the self-hosted relay turns the relay off again", async () => {
  await machine.runPromise(Relay.use((relay) => relay.stopSelfHosted))
  await relayStatus((status) => status.state === "off")
  const { selfHostedRelay } = await machine.runPromise(Settings.use((settings) => settings.get))
  expect(selfHostedRelay).toBeNull()
})
