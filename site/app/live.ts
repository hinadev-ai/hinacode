import type { HinacodeBridge, PushEvent, RpcEnvelope } from "../../src/shared/contract.ts"
import { REMOTE_PATH } from "../../src/shared/remote.ts"
import { desktopShim } from "./desktop.ts"
import type { RecordedCall, RecordedEvent, Recording } from "./recording.ts"

const PING_MS = 15_000

export function liveBridge(address: string, token: string): { bridge: HinacodeBridge; recording: () => Recording } {
  const desktop = desktopShim("en")
  const startedAt = Date.now()
  const entries: Array<RecordedCall | RecordedEvent> = []
  const pending = new Map<number, (envelope: RpcEnvelope<unknown>) => void>()
  const listeners = new Set<(event: typeof PushEvent.Encoded) => void>()
  const socket = new WebSocket(`ws://${address}${REMOTE_PATH}`)
  let nextId = 1
  const ready = new Promise<void>((resolve) => {
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token })))
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data))
      if (frame.type === "ready") resolve()
      if (frame.type === "result") {
        pending.get(frame.id)?.(frame.envelope)
        pending.delete(frame.id)
      }
      if (frame.type === "event") {
        entries.push({ kind: "event", at: Date.now() - startedAt, event: frame.event })
        for (const listener of listeners) listener(frame.event)
      }
      if (frame.type === "ask") {
        const error = { tag: "Unsupported", message: "The recorder answers no asks" }
        socket.send(JSON.stringify({ type: "answer", id: frame.id, envelope: { error } }))
      }
    })
  })
  setInterval(() => socket.send(JSON.stringify({ type: "ping", at: Date.now() })), PING_MS)

  const bridge: HinacodeBridge = {
    rpc: async (method, payload) => {
      const local = desktop(method, payload)
      if (local) return local as never
      await ready
      const id = nextId++
      const index =
        entries.push({ kind: "call", at: Date.now() - startedAt, method, payload, envelope: { result: null } }) - 1
      const envelope = await new Promise<RpcEnvelope<unknown>>((resolve) => {
        pending.set(id, resolve)
        socket.send(JSON.stringify({ type: "call", id, method, payload }))
      })
      entries[index] = { ...(entries[index] as RecordedCall), envelope }
      return envelope as never
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    pathForFile: (file) => file.name,
    liquidGlass: false,
  }
  return { bridge, recording: () => ({ recordedAt: startedAt, entries }) }
}
