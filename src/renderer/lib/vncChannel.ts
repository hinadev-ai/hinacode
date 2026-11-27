import { streamVmScreen, type VmScreenStream } from "../../shared/vmScreenStream.ts"
import { errorMessage } from "./errorMessage.ts"
import { callPromise } from "./rpc.ts"

type ReadyState = "connecting" | "open" | "closing" | "closed"

interface VncCloseEvent {
  readonly code: number
  readonly reason: string
  readonly wasClean: boolean
}

// FIXME: noVNC checks that every public field exists before it attaches, so they stay fields even while null
export class VncChannel {
  binaryType = "arraybuffer"
  readonly protocol = ""
  readyState: ReadyState = "connecting"
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: ArrayBuffer }) => void) | null = null
  onclose: ((event: VncCloseEvent) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  readonly #stream: VmScreenStream

  constructor(threadId: string) {
    const streamId = crypto.randomUUID()
    this.#stream = streamVmScreen(
      {
        open: () => callPromise("vm.screen.open", { threadId, streamId }),
        read: (offset) => callPromise("vm.screen.read", { streamId, offset }),
        send: (data) => callPromise("vm.screen.send", { streamId, data }),
        close: () => callPromise("vm.screen.close", { streamId }),
      },
      {
        onOpen: () => {
          this.readyState = "open"
          this.onopen?.()
        },
        onData: (data) => {
          const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          this.onmessage?.({ data: buffer as ArrayBuffer })
        },
        onEnd: (failure) => {
          this.readyState = "closed"
          if (failure === undefined) return this.onclose?.({ code: 1000, reason: "", wasClean: true })
          this.onerror?.(failure)
          this.onclose?.({ code: 1006, reason: errorMessage(failure), wasClean: false })
        },
      },
    )
  }

  send(data: Uint8Array) {
    if (this.readyState === "open") this.#stream.send(data)
  }

  close() {
    if (this.readyState === "closing" || this.readyState === "closed") return
    this.readyState = "closing"
    this.#stream.close()
  }
}
