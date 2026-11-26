import { createServer } from "node:net"
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { WebSocket } from "ws"
import type { RpcEnvelope, RpcMethod, RpcRequestEncoded, RpcResponseEncoded } from "../../shared/contract.ts"
import {
  approvalCode,
  type Channel,
  commitment,
  decodeKey,
  generateKeyPair,
  initiate,
  type KeyPair,
  newNonce,
  REMOTE_PROLOGUE,
  sameBytes,
} from "../../shared/noise.ts"
import { type ClientFrame, remoteWebSocketUrl, type ServerFrame } from "../../shared/remote.ts"

export const unusedLoopbackPort = async (): Promise<number> => {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", resolve)
  })
  try {
    const address = reservation.address()
    if (address === null || typeof address === "string") throw new Error("No TCP address for the reserved port")
    return address.port
  } finally {
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  }
}

type Hello = Omit<Extract<ClientFrame, { type: "hello" }>, "type">

export interface RawFrame {
  readonly data: Buffer
  readonly binary: boolean
}

const utf8 = new TextDecoder()

export const remoteClient = (
  target: number | URL,
  hostKey: string,
  options: { readonly device?: KeyPair; readonly autoPong?: boolean } = {},
) => {
  const device = options.device ?? generateKeyPair()
  const remoteStatic = decodeKey(hostKey)
  if (remoteStatic === null) throw new Error(`Not a host key: ${hostKey}`)
  const initiator = initiate({ prologue: REMOTE_PROLOGUE, local: device, remoteStatic, payload: new Uint8Array(0) })
  const url = typeof target === "number" ? remoteWebSocketUrl({ host: "127.0.0.1", port: target }) : target
  const socket = new WebSocket(url, {
    ...(options.autoPong !== undefined && { autoPong: options.autoPong }),
  })
  const raw: Array<RawFrame> = []
  const plain: Array<Record<string, unknown>> = []
  const frames: Array<ServerFrame> = []
  const sealed: Array<Uint8Array> = []
  const watchers = new Set<() => void>()
  let channel: Channel | null = null
  let started = false
  let closed: { code: number; reason: string } | null = null
  const finish = (reply: Uint8Array) => {
    try {
      return initiator.finish(reply).channel
    } catch {
      return null
    }
  }
  const notify = () => {
    for (const check of watchers) check()
  }
  socket.on("message", (data: Buffer, binary) => {
    raw.push({ data, binary })
    if (!binary) plain.push(JSON.parse(String(data)) as Record<string, unknown>)
    else if (channel === null) channel = finish(data)
    else frames.push(JSON.parse(utf8.decode(channel.decrypt(data))) as ServerFrame)
    notify()
  })
  socket.on("close", (code, reason) => {
    closed = { code, reason: String(reason) }
    notify()
  })
  socket.on("error", () => {})
  const until = <A>(pick: () => A | undefined) =>
    new Promise<A>((resolve) => {
      const check = () => {
        const found = pick()
        if (found === undefined) return
        watchers.delete(check)
        resolve(found)
      }
      watchers.add(check)
      check()
    })
  const opened = new Promise<void>((resolve) => socket.once("open", resolve))
  const frame = <T extends ServerFrame["type"]>(type: T) =>
    until(() => frames.find((f): f is Extract<ServerFrame, { type: T }> => f.type === type))

  const handshake = async () => {
    await opened
    if (!started) socket.send(initiator.message)
    started = true
    const secured = await until(() => channel ?? (closed === null ? undefined : null))
    if (secured === null) throw new Error(`socket closed during the handshake: ${closed!.code}`)
    return secured
  }

  const send = async (sent: ClientFrame | string) => {
    const secured = await handshake()
    const ciphertext = secured.encrypt(utf8ToBytes(typeof sent === "string" ? sent : JSON.stringify(sent)))
    sealed.push(ciphertext)
    socket.send(ciphertext)
  }

  let nextId = 1
  return {
    socket,
    device,
    message: initiator.message,
    raw,
    plain,
    frames,
    sealed,
    opened,
    pinged: new Promise<void>((resolve) => socket.once("ping", () => resolve())),
    handshake,
    send,
    sendRaw: async (data: string | Uint8Array) => {
      await opened
      socket.send(data)
    },
    hello: (hello: Hello) => send({ type: "hello", ...hello }),
    call: async <M extends RpcMethod>(method: M, payload: RpcRequestEncoded<M>, key?: string) => {
      const id = nextId++
      await send({ type: "call", id, method, ...(payload !== undefined && { payload }), ...(key && { key }) })
      const answer = await until(() => frames.find((f) => f.type === "result" && f.id === id) ?? closed ?? undefined)
      if (!("type" in answer)) throw new Error(`socket closed before the answer: ${answer.code} ${answer.reason}`)
      return (answer as Extract<ServerFrame, { type: "result" }>).envelope as RpcEnvelope<RpcResponseEncoded<M>>
    },
    approvalCode: async () => {
      const { commitment: committed } = await frame("pending")
      const clientNonce = newNonce()
      await send({ type: "approval", nonce: bytesToHex(clientNonce) })
      const serverNonce = hexToBytes((await frame("approval")).nonce)
      if (!sameBytes(commitment(serverNonce), hexToBytes(committed))) throw new Error("the server broke its commitment")
      return approvalCode((await handshake()).handshakeHash, clientNonce, serverNonce)
    },
    challenge: () => until(() => plain.find((f) => f["type"] === "challenge")),
    plainReady: () => until(() => plain.find((f) => f["type"] === "ready")),
    ready: () => frame("ready"),
    pending: () => frame("pending"),
    pong: (at: number) => until(() => frames.find((f) => f.type === "pong" && f.at === at)),
    event: (predicate: (event: Extract<ServerFrame, { type: "event" }>["event"]) => boolean) =>
      until(() => frames.find((f) => f.type === "event" && predicate(f.event))),
    answered: (count: number) =>
      until(() => (frames.filter((f) => f.type === "result").length >= count ? true : undefined)),
    closed: () => until(() => closed ?? undefined),
  }
}

export type RemoteClient = ReturnType<typeof remoteClient>
