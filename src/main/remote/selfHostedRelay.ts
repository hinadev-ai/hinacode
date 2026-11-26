import type { ClientRequest, IncomingMessage } from "node:http"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { connect, type Socket } from "node:net"

export const RELAY_UPGRADE_PROTOCOL = "hinacode-relay/1"

const SIGNAL_PING = 0x00
const SIGNAL_OPEN = 0x01
const ATTACH_TIMEOUT_MS = 10_000
const FIRST_RETRY_MS = 1000
const LAST_RETRY_MS = 30_000

export interface RelayAttachment {
  readonly url: URL
  readonly hostId: string
  readonly token: string
  readonly origin: { readonly host: string; readonly port: number }
  readonly idle: number
}

export type AttachmentState =
  | { readonly state: "connected" }
  | { readonly state: "connecting"; readonly error: string | null }

export const relayAddress = ({ url, hostId }: Pick<RelayAttachment, "url" | "hostId">) => `${url.host}/h/${hostId}`

export const describeRefusal = (status: number | undefined) =>
  status === 401
    ? "The relay refused this machine's token."
    : `The relay answered ${status ?? "nothing"} instead of switching protocols.`

const splice = (relay: Socket, local: Socket) => {
  relay.pipe(local)
  local.pipe(relay)
  const destroyBoth = () => {
    relay.destroy()
    local.destroy()
  }
  relay.once("error", destroyBoth)
  local.once("error", destroyBoth)
  relay.once("close", () => local.end())
  local.once("close", () => relay.end())
}

export const attachToRelay = (
  attachment: RelayAttachment,
  onState: (state: AttachmentState) => void,
): { readonly close: () => void } => {
  const request = attachment.url.protocol === "https:" ? httpsRequest : httpRequest
  const parked = new Set<Socket>()
  const sessions = new Set<Socket>()
  const dialing = new Set<ClientRequest>()
  let closed = false
  let retryMs = FIRST_RETRY_MS
  let retry: NodeJS.Timeout | null = null
  let lastError: string | null = null

  const report = () => {
    if (closed) return
    onState(parked.size > 0 ? { state: "connected" } : { state: "connecting", error: lastError })
  }

  const fail = (error: string) => {
    lastError = error
    report()
    if (closed || retry !== null) return
    retry = setTimeout(() => {
      retry = null
      refill()
    }, retryMs)
    retryMs = Math.min(retryMs * 2, LAST_RETRY_MS)
  }

  const open = (relay: Socket, rest: Buffer) => {
    parked.delete(relay)
    relay.removeAllListeners("data")
    relay.write(Buffer.of(SIGNAL_OPEN))
    refill()
    report()
    const local = connect({ host: attachment.origin.host, port: attachment.origin.port, noDelay: true })
    sessions.add(relay)
    relay.once("close", () => sessions.delete(relay))
    if (rest.length > 0) local.write(rest)
    splice(relay, local)
  }

  const park = (relay: Socket, head: Buffer) => {
    retryMs = FIRST_RETRY_MS
    lastError = null
    relay.setNoDelay(true)
    relay.setKeepAlive(true, 15_000)
    parked.add(relay)
    const onSignals = (chunk: Buffer) => {
      for (let at = 0; at < chunk.length; at += 1) {
        if (chunk[at] === SIGNAL_PING) {
          relay.write(Buffer.of(SIGNAL_PING))
          continue
        }
        if (chunk[at] === SIGNAL_OPEN) return open(relay, chunk.subarray(at + 1))
        return relay.destroy()
      }
    }
    relay.on("data", onSignals)
    relay.once("close", () => {
      if (!parked.delete(relay)) return
      report()
      refill()
    })
    relay.on("error", () => {})
    report()
    if (head.length > 0) onSignals(head)
  }

  const dial = () => {
    const attach = request(attachment.url, {
      method: "GET",
      path: `/h/${attachment.hostId}/attach`,
      agent: false,
      timeout: ATTACH_TIMEOUT_MS,
      headers: {
        authorization: `Bearer ${attachment.token}`,
        connection: "Upgrade",
        upgrade: RELAY_UPGRADE_PROTOCOL,
      },
    })
    dialing.add(attach)
    const settle = () => dialing.delete(attach)
    attach.once("upgrade", (_response: IncomingMessage, socket: Socket, head: Buffer) => {
      if (!settle() || closed) return void socket.destroy()
      socket.setTimeout(0)
      park(socket, head)
    })
    attach.once("response", (response: IncomingMessage) => {
      response.resume()
      if (settle()) fail(describeRefusal(response.statusCode))
    })
    attach.once("timeout", () => attach.destroy(new Error("the relay did not answer within 10 seconds")))
    attach.on("error", (error) => {
      if (settle()) fail(`Cannot reach the relay: ${error.message}`)
    })
    attach.end()
  }

  const refill = () => {
    if (closed || retry !== null) return
    while (parked.size + dialing.size < attachment.idle) dial()
  }

  report()
  refill()

  return {
    close: () => {
      closed = true
      if (retry !== null) clearTimeout(retry)
      for (const pending of dialing) pending.destroy()
      for (const socket of [...parked, ...sessions]) socket.destroy()
      dialing.clear()
      parked.clear()
      sessions.clear()
    },
  }
}
