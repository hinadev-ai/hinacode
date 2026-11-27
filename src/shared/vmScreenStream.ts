import type { VmScreenChunk } from "./domain.ts"

export interface VmScreenCalls {
  readonly open: () => Promise<void>
  readonly read: (offset: number) => Promise<VmScreenChunk>
  readonly send: (data: Uint8Array) => Promise<void>
  readonly close: () => Promise<void>
}

export interface VmScreenHandlers {
  readonly onOpen: () => void
  readonly onData: (data: Uint8Array) => void
  readonly onEnd: (failure: unknown) => void
}

export interface VmScreenStream {
  readonly send: (data: Uint8Array) => void
  readonly close: () => void
}

const READ_RETRIES = 3
const READ_RETRY_DELAY_MS = 1000

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  if (parts.length === 1) return parts[0]!
  const joined = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return joined
}

export const streamVmScreen = (calls: VmScreenCalls, handlers: VmScreenHandlers): VmScreenStream => {
  let state: "opening" | "open" | "closing" | "ended" = "opening"
  const isOpen = () => state === "open"
  let offset = 0
  let unsent: Array<Uint8Array> = []
  let sending = false

  const end = (failure?: unknown) => {
    if (state === "ended") return
    state = "ended"
    unsent = []
    handlers.onEnd(failure)
  }

  const readUntilEnd = async () => {
    let failures = 0
    while (isOpen()) {
      const chunk = await calls.read(offset).then(
        (value) => value,
        (cause: unknown) => ({ status: "failed" as const, cause }),
      )
      if (!isOpen()) return
      if (chunk.status === "failed") {
        failures++
        if (failures > READ_RETRIES) return end(chunk.cause)
        await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAY_MS))
        continue
      }
      failures = 0
      if (chunk.status === "closed") return end()
      if (chunk.data.length === 0) continue
      offset += chunk.data.length
      handlers.onData(chunk.data)
    }
  }

  const sendUnsent = async () => {
    sending = true
    while (unsent.length > 0 && isOpen()) {
      const data = concat(unsent)
      unsent = []
      const failure = await calls.send(data).then(
        () => undefined,
        (cause: unknown) => ({ cause }),
      )
      if (failure !== undefined) end(failure.cause)
    }
    sending = false
  }

  const opened = calls.open().then(
    () => {
      if (state !== "opening") return
      state = "open"
      handlers.onOpen()
      void readUntilEnd()
      if (unsent.length > 0) void sendUnsent()
    },
    (cause: unknown) => end(cause),
  )

  return {
    send: (data) => {
      if (state !== "opening" && state !== "open") return
      unsent.push(data.slice())
      if (state === "open" && !sending) void sendUnsent()
    },
    close: () => {
      if (state === "closing" || state === "ended") return
      state = "closing"
      unsent = []
      void opened
        .then(() => calls.close())
        .catch(() => {})
        .finally(() => end())
    },
  }
}
