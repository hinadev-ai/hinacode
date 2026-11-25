import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { unlistedModel } from "../../shared/agent.ts"
import type { PushEvent, RpcEnvelope, RpcMethod, RpcRequestEncoded } from "../../shared/contract.ts"
import { encodeKey } from "../../shared/noise.ts"
import { clientProof, newNonce, serverProof } from "../../shared/proof.ts"
import {
  CLOSE_HANDSHAKE_FAILED,
  CLOSE_MALFORMED_FRAME,
  CLOSE_PAIRING_RESET,
  CLOSE_UNAUTHORIZED,
  REMOTE_PROTOCOL_VERSION,
} from "../../shared/remote.ts"
import { connect } from "../../cli/client.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import { PiProvider } from "../agents/pi/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import * as Db from "../db/client.ts"
import { dispatch } from "../rpc.ts"
import { makeEventsLayer } from "../services/Events.ts"
import * as SecretsModule from "../services/Secrets.ts"
import { Settings } from "../services/Settings.ts"
import { makeTestAppLayer } from "../testing.ts"
import { RemoteAccess } from "./access.ts"
import * as CliSocket from "./cliSocket.ts"
import { cliSocketPath } from "./cliSocketPath.ts"
import { type RemoteClient, remoteClient, unusedLoopbackPort } from "./testing.ts"

vi.mock("electron", () => ({
  Notification: EventTarget,
  app: { getPath: () => "", focus: () => {} },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const LEGACY_TOKEN = "token-from-before-encryption"

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

const pushes: Array<typeof PushEvent.Encoded> = []

const makeMachine = (dataDir: string) => {
  const events = makeEventsLayer((event) => void pushes.push(event))
  return ManagedRuntime.make(
    CliSocket.layer(dataDir).pipe(
      Layer.provideMerge(makeTestAppLayer(join(dataDir, "hinacode.sqlite"), { providers, events })),
      Layer.provide(events),
    ),
  )
}

const seedLegacyToken = (database: string) =>
  Effect.runPromise(
    SecretsModule.Secrets.use((secrets) => secrets.set("remote.token", LEGACY_TOKEN)).pipe(
      Effect.provide(
        SecretsModule.layer.pipe(
          Layer.provide(Layer.mergeAll(Db.layer(database), SecretsModule.noKeyring, NodeServices.layer)),
        ),
      ),
    ),
  )

let dir = ""
let port = 0
let machine: ReturnType<typeof makeMachine>

const invoke = async <M extends RpcMethod>(method: M, payload: RpcRequestEncoded<M>) =>
  (await machine.runPromise(dispatch({ method, payload }, null))) as RpcEnvelope<never>

const result = <A>(envelope: RpcEnvelope<A>): A => {
  if ("error" in envelope) throw new Error(`${envelope.error.tag}: ${envelope.error.message}`)
  return envelope.result
}

const pairing = () => machine.runPromise(RemoteAccess.use((access) => access.pairing))
const devices = () => machine.runPromise(RemoteAccess.use((access) => access.devices))

const keyOf = (client: RemoteClient) => encodeKey(client.device.publicKey)

const enrolled = async (name = "phone") => {
  const { key, secret } = await pairing()
  const client = remoteClient(port, key)
  await client.hello({ name, secret })
  await client.ready()
  return client
}

const waiting = async (name = "laptop", options: { verify?: boolean; client?: RemoteClient } = {}) => {
  const client = options.client ?? remoteClient(port, (await pairing()).key)
  await client.hello({ name, ...(options.verify && { verify: true }) })
  const code = await client.approvalCode()
  await vi.waitFor(async () => expect((await devices()).waiting).toBeGreaterThan(0))
  return { client, code }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kk-remote-devices-"))
  mkdirSync(join(dir, "machine"), { mode: 0o700 })
  await seedLegacyToken(join(dir, "machine", "hinacode.sqlite"))
  port = await unusedLoopbackPort()
  machine = makeMachine(join(dir, "machine"))
  await machine.runPromise(
    Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port } })),
  )
  await vi.waitFor(async () =>
    expect((await machine.runPromise(RemoteAccess.use((access) => access.status))).listening).toBe(true),
  )
}, 60_000)

afterAll(async () => {
  await machine.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test("the secret enrolls one device and is then replaced, so a second device with it waits", async () => {
  const before = await pairing()
  const phone = remoteClient(port, before.key)
  await phone.hello({ name: "phone", secret: before.secret })
  expect(await phone.ready()).toMatchObject({ type: "ready", version: REMOTE_PROTOCOL_VERSION })

  const after = await pairing()
  expect(after.key).toBe(before.key)
  expect(after.secret).not.toBe(before.secret)
  expect((await devices()).devices).toContainEqual(
    expect.objectContaining({ key: keyOf(phone), name: "phone", connected: true }),
  )
  expect(pushes).toContainEqual({ type: "remote.devices.changed", reason: "enrolled", name: "phone" })

  const tablet = remoteClient(port, before.key)
  await tablet.hello({ name: "tablet", secret: before.secret })
  await tablet.pending()
  expect((await devices()).devices.map((device) => device.key)).not.toContain(keyOf(tablet))
  phone.socket.close()
  tablet.socket.close()
})

test("an unknown key waits, and the code it shows lets it in once typed on the machine", async () => {
  const { client, code } = await waiting("laptop")
  expect(pushes.at(-1)).toStrictEqual({ type: "remote.devices.changed", reason: "waiting" })

  const device = result(await invoke("remote.devices.approve", { code: code.replace("-", "").toLowerCase() }))
  expect(device).toMatchObject({ key: keyOf(client), name: "laptop" })
  await client.ready()
  expect(result(await client.call("projects.list", undefined))).toBeInstanceOf(Array)
  expect((await devices()).waiting).toBe(0)

  const again = remoteClient(port, (await pairing()).key, { device: client.device })
  await again.hello({ name: "laptop" })
  await again.ready()
  again.socket.close()
  client.socket.close()
})

test("a trusted device that asks to verify the machine still waits for its code", async () => {
  const phone = await enrolled("verifier")
  phone.socket.close()
  const { client, code } = await waiting("verifier", {
    verify: true,
    client: remoteClient(port, (await pairing()).key, { device: phone.device }),
  })
  result(await invoke("remote.devices.approve", { code }))
  await client.ready()
  expect((await devices()).devices.filter((device) => device.key === keyOf(client))).toHaveLength(1)
  client.socket.close()
})

test("a wrong code is refused, and a waiting device that sends a call is closed", async () => {
  const { client, code } = await waiting("stranger")
  const wrong = code === "000-000" ? "111-111" : "000-000"
  expect(await invoke("remote.devices.approve", { code: wrong })).toStrictEqual({
    error: { tag: "NoWaitingDeviceError", message: "No waiting device shows that code" },
  })
  await client.send({ type: "call", id: 1, method: "projects.list" })
  expect((await client.closed()).code).toBe(CLOSE_MALFORMED_FRAME)
})

test("a replayed handshake opens nothing, with or without the recorded hello", async () => {
  const victim = await enrolled("victim")
  const before = await devices()

  const replay = remoteClient(port, (await pairing()).key)
  await replay.sendRaw(victim.message)
  await vi.waitFor(() => expect(replay.raw.filter((frame) => frame.binary)).toHaveLength(1))
  await replay.sendRaw(victim.sealed[0]!)
  expect((await replay.closed()).code).toBe(CLOSE_MALFORMED_FRAME)
  expect(replay.raw.filter((frame) => frame.binary)).toHaveLength(1)
  expect(await devices()).toStrictEqual(before)
  victim.socket.close()
})

test("removing a device closes its session at once and it waits from then on", async () => {
  const phone = await enrolled("lost phone")
  const { secret } = await pairing()
  result(await invoke("remote.devices.remove", { key: keyOf(phone) }))
  expect((await phone.closed()).code).toBe(CLOSE_UNAUTHORIZED)
  expect((await pairing()).secret).not.toBe(secret)
  expect(pushes.at(-1)).toStrictEqual({ type: "remote.devices.changed", reason: "removed", name: "lost phone" })

  const again = remoteClient(port, (await pairing()).key, { device: phone.device })
  await again.hello({ name: "lost phone" })
  await again.pending()
  again.socket.close()
})

test("a ninth waiting device closes the oldest", async () => {
  const { key } = await pairing()
  const strangers = Array.from({ length: 9 }, () => remoteClient(port, key))
  for (const stranger of strangers) {
    await stranger.hello({ name: "stranger" })
    await stranger.pending()
  }
  expect((await strangers[0]!.closed()).code).toBe(CLOSE_UNAUTHORIZED)
  for (const stranger of strangers) stranger.socket.close()
})

test("a frame over 1 KiB before ready closes the socket", async () => {
  const client = remoteClient(port, (await pairing()).key)
  await client.send(`${" ".repeat(1024)}${JSON.stringify({ type: "hello", name: "padded" })}`)
  expect((await client.closed()).code).toBe(CLOSE_MALFORMED_FRAME)
})

test("every frame after the challenge is binary and none of it reads as JSON", async () => {
  const phone = await enrolled("wire")
  expect(result(await phone.call("projects.list", undefined))).toBeInstanceOf(Array)
  await phone.send({ type: "ping", at: 7 })
  await phone.pong(7)
  const [challenge, ...rest] = phone.raw
  expect(challenge?.binary).toBe(false)
  expect(rest.length).toBeGreaterThanOrEqual(4)
  for (const frame of rest) {
    expect(frame.binary).toBe(true)
    expect(() => JSON.parse(frame.data.toString("utf8"))).toThrow()
  }
  phone.socket.close()
})

test("a client from before encryption that proves the old token hears version 2, and a wrong proof is refused", async () => {
  const { key } = await pairing()
  const old = remoteClient(port, key)
  const challenge = (await old.challenge()) as { nonce: string }
  const nonce = newNonce()
  await old.sendRaw(JSON.stringify({ type: "auth", nonce, proof: clientProof(LEGACY_TOKEN, challenge.nonce, nonce) }))
  expect(await old.plainReady()).toStrictEqual({
    type: "ready",
    version: REMOTE_PROTOCOL_VERSION,
    proof: serverProof(LEGACY_TOKEN, nonce, challenge.nonce),
  })
  expect((await old.closed()).code).toBe(1000)

  const older = remoteClient(port, key)
  await older.sendRaw(JSON.stringify({ type: "auth", token: LEGACY_TOKEN }))
  expect(await older.plainReady()).toStrictEqual({ type: "ready", version: REMOTE_PROTOCOL_VERSION })

  const forged = remoteClient(port, key)
  const forgedChallenge = (await forged.challenge()) as { nonce: string }
  await forged.sendRaw(
    JSON.stringify({ type: "auth", nonce, proof: clientProof("not-the-token", forgedChallenge.nonce, nonce) }),
  )
  expect((await forged.closed()).code).toBe(CLOSE_UNAUTHORIZED)
})

test("a remote device cannot manage devices, and the CLI socket can", async () => {
  const phone = await enrolled("remote admin")
  for (const method of ["remote.devices", "remote.devices.approve", "remote.devices.remove"] as const) {
    const payload =
      method === "remote.devices" ? undefined : method === "remote.devices.approve" ? { code: "x" } : { key: "x" }
    expect((await phone.call(method, payload as never)) as unknown).toMatchObject({ error: { tag: "MachineOnly" } })
  }

  const { client, code } = await waiting("approved from the cli")
  const approved = await machine.runPromise(
    Effect.scoped(
      Effect.flatMap(connect(cliSocketPath(join(dir, "machine"))), (cli) =>
        cli.call("remote.devices.approve", { code }),
      ),
    ),
  )
  expect(approved.key).toBe(keyOf(client))
  await client.ready()
  client.socket.close()
  phone.socket.close()
})

test("resetting pairing closes every session, and the old host key no longer completes a handshake", async () => {
  const phone = await enrolled("before reset")
  const { key } = await pairing()
  result(await invoke("remote.resetPairing", undefined))
  expect((await phone.closed()).code).toBe(CLOSE_PAIRING_RESET)
  expect((await devices()).devices).toStrictEqual([])

  const stale = remoteClient(port, key, { device: phone.device })
  await expect(stale.handshake()).rejects.toThrow()
  expect((await stale.closed()).code).toBe(CLOSE_HANDSHAKE_FAILED)
})
