// oxlint-disable unicorn/prefer-add-event-listener -- VncChannel has only the on* handler fields noVNC assigns.
import { describe, expect, test, vi } from "vitest"
import { VncChannel } from "./vncChannel.ts"

interface Call {
  readonly method: string
  readonly payload: { readonly streamId: string; readonly data?: Uint8Array }
  readonly resolve: () => void
}

function fakeBridge() {
  const calls: Array<Call> = []
  const waiters: Array<{ method: string; seen: number; resolve: (call: Call) => void }> = []
  const listeners = new Set<(event: unknown) => void>()
  vi.stubGlobal("window", {
    hinacode: {
      rpc: (method: string, payload: Call["payload"]) =>
        new Promise((resolve) => {
          const call = { method, payload, resolve: () => resolve({ result: undefined }) }
          calls.push(call)
          for (const waiter of waiters.filter((candidate) => candidate.method === method)) {
            if (calls.filter((other) => other.method === method).length > waiter.seen) {
              waiters.splice(waiters.indexOf(waiter), 1)
              waiter.resolve(call)
            }
          }
        }),
      onEvent: (listener: (event: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  })
  /** The next call of `method` after the ones already made. */
  const nextCall = (method: string) => {
    const seen = calls.filter((call) => call.method === method).length
    return new Promise<Call>((resolve) => waiters.push({ method, seen, resolve }))
  }
  const push = (event: unknown) => {
    for (const listener of listeners) listener(event)
  }
  const sent = () =>
    calls.filter((call) => call.method === "vm.screen.send").map((call) => [...(call.payload.data ?? [])])
  return { nextCall, push, sent, listeners }
}

async function openChannel(bridge: ReturnType<typeof fakeBridge>) {
  const opening = bridge.nextCall("vm.screen.open")
  const channel = new VncChannel("thread-1")
  const opened = new Promise<void>((resolve) => (channel.onopen = resolve))
  const open = await opening
  return { channel, open, opened, streamId: open.payload.streamId }
}

describe("VncChannel", () => {
  test("delivers data pushed before the open rpc resolves after onopen, in order", async () => {
    const bridge = fakeBridge()
    const { channel, open, opened, streamId } = await openChannel(bridge)
    const chunks: Array<Array<number>> = []
    channel.onmessage = (event) => chunks.push([...new Uint8Array(event.data)])
    const chunksAtOpen: Array<number> = []
    const resolveOpened = channel.onopen
    channel.onopen = () => {
      chunksAtOpen.push(chunks.length)
      resolveOpened?.()
    }

    bridge.push({ type: "vm.screen.data", streamId, data: new Uint8Array([1, 2]) })
    bridge.push({ type: "vm.screen.data", streamId: "other", data: new Uint8Array([9]) })
    bridge.push({ type: "vm.screen.data", streamId, data: new Uint8Array([3]) })
    expect(chunks).toEqual([])

    open.resolve()
    await opened
    bridge.push({ type: "vm.screen.data", streamId, data: new Uint8Array([4]) })

    expect(channel.readyState).toBe("open")
    expect(chunksAtOpen).toEqual([0])
    expect(chunks).toEqual([[1, 2], [3], [4]])
  })

  test("sends reach rpc in call order even when earlier calls resolve later", async () => {
    const bridge = fakeBridge()
    const { channel, open, opened } = await openChannel(bridge)
    open.resolve()
    await opened

    const first = bridge.nextCall("vm.screen.send")
    channel.send(new Uint8Array([1]))
    channel.send(new Uint8Array([2]))
    channel.send(new Uint8Array([3]))
    const firstCall = await first
    expect(bridge.sent()).toEqual([[1]])

    const second = bridge.nextCall("vm.screen.send")
    firstCall.resolve()
    const secondCall = await second
    expect(bridge.sent()).toEqual([[1], [2]])

    const third = bridge.nextCall("vm.screen.send")
    secondCall.resolve()
    await third
    expect(bridge.sent()).toEqual([[1], [2], [3]])
  })

  test("sends a copy of the bytes", async () => {
    const bridge = fakeBridge()
    const { channel, open, opened } = await openChannel(bridge)
    open.resolve()
    await opened

    const sending = bridge.nextCall("vm.screen.send")
    const buffer = new Uint8Array([5, 6, 7, 8])
    channel.send(new Uint8Array(buffer.buffer, 1, 2))
    buffer.fill(0)
    await sending

    expect(bridge.sent()).toEqual([[6, 7]])
  })

  test("fires onclose when main closes the stream", async () => {
    const bridge = fakeBridge()
    const { channel, open, opened, streamId } = await openChannel(bridge)
    const onclose = vi.fn()
    channel.onclose = onclose
    open.resolve()
    await opened

    bridge.push({ type: "vm.screen.closed", streamId })

    expect(onclose).toHaveBeenCalledOnce()
    expect(onclose.mock.calls[0]?.[0]).toMatchObject({ code: expect.any(Number), reason: expect.any(String) })
    expect(channel.readyState).toBe("closed")
    expect(bridge.listeners.size).toBe(0)
  })
})
