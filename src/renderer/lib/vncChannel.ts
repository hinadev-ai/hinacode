import { errorMessage } from "./errorMessage.ts"
import { callPromise, onPushEvent } from "./rpc.ts"

type ReadyState = "connecting" | "open" | "closing" | "closed"

export interface VncCloseEvent {
  readonly code: number
  readonly reason: string
  readonly wasClean: boolean
}

/**
 * A WebSocket-shaped channel to a thread's VNC server, carried over rpc, for noVNC's `RFB`. noVNC checks that
 * every public field below exists before it attaches, so they stay class fields even while null.
 */
export class VncChannel {
  binaryType = "arraybuffer"
  readonly protocol = ""
  readyState: ReadyState = "connecting"
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: ArrayBuffer }) => void) | null = null
  onclose: ((event: VncCloseEvent) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  readonly #streamId = crypto.randomUUID()
  /** Data that arrived before `onopen`. Null once open. */
  #early: Array<Uint8Array> | null = []
  #sending: Promise<void> = Promise.resolve()
  readonly #opened: Promise<void>
  readonly #unsubscribe: () => void

  constructor(threadId: string) {
    // Subscribed before opening, since main may push the server's first bytes before the rpc resolves.
    this.#unsubscribe = onPushEvent((event) => {
      if (event.type === "vm.screen.data" && event.streamId === this.#streamId) this.#receive(event.data)
      if (event.type === "vm.screen.closed" && event.streamId === this.#streamId) {
        this.#finish({ code: 1000, reason: "", wasClean: true })
      }
    })
    this.#opened = callPromise("vm.screen.open", { threadId, streamId: this.#streamId }).then(
      () => this.#open(),
      (cause: unknown) => this.#fail(cause),
    )
  }

  /** Copies the bytes at once: noVNC reuses the buffer behind `data`. */
  send(data: Uint8Array) {
    if (this.readyState !== "open") return
    const bytes = data.slice()
    this.#sending = this.#sending
      .then(() =>
        this.readyState === "open"
          ? callPromise("vm.screen.send", { streamId: this.#streamId, data: bytes })
          : undefined,
      )
      .catch((cause: unknown) => this.#fail(cause))
  }

  close() {
    if (this.readyState === "closing" || this.readyState === "closed") return
    this.readyState = "closing"
    this.#early = null
    // After the open settles, so main never sees the close before the stream exists.
    void this.#opened
      .then(() => callPromise("vm.screen.close", { streamId: this.#streamId }))
      .catch(() => {})
      .finally(() => this.#finish({ code: 1000, reason: "", wasClean: true }))
  }

  #open() {
    if (this.readyState !== "connecting") return
    this.readyState = "open"
    this.onopen?.()
    const early = this.#early ?? []
    this.#early = null
    for (const data of early) this.#deliver(data)
  }

  #receive(data: Uint8Array) {
    if (this.#early) this.#early.push(data)
    else if (this.readyState === "open") this.#deliver(data)
  }

  #deliver(data: Uint8Array) {
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    this.onmessage?.({ data: buffer as ArrayBuffer })
  }

  #fail(cause: unknown) {
    if (this.readyState === "closed") return
    this.onerror?.(cause)
    this.#finish({ code: 1006, reason: errorMessage(cause), wasClean: false })
  }

  #finish(event: VncCloseEvent) {
    if (this.readyState === "closed") return
    this.readyState = "closed"
    this.#early = null
    this.#unsubscribe()
    this.onclose?.(event)
  }
}
