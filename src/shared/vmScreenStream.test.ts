import { describe, expect, test } from "vitest"
import type { VmScreenChunk } from "./domain.ts"
import { streamVmScreen, type VmScreenCalls } from "./vmScreenStream.ts"

interface Pending<A, I> {
  readonly input: I
  readonly resolve: (value: A) => void
  readonly reject: (cause: unknown) => void
}

function fakeCalls() {
  const opens: Array<Pending<void, undefined>> = []
  const reads: Array<Pending<VmScreenChunk, number>> = []
  const sends: Array<Pending<void, Array<number>>> = []
  const closes: Array<Pending<void, undefined>> = []
  const pending =
    <A, I>(list: Array<Pending<A, I>>) =>
    (input: I) =>
      new Promise<A>((resolve, reject) => list.push({ input, resolve, reject }))
  const calls: VmScreenCalls = {
    open: () => pending(opens)(undefined),
    read: pending(reads),
    send: (data) => pending(sends)([...data]),
    close: () => pending(closes)(undefined),
  }
  return { calls, opens, reads, sends, closes }
}

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => Promise.resolve())

async function settled(times = 4) {
  for (let index = 0; index < times; index++) await settle()
}

function recorder() {
  const events: Array<string> = []
  return {
    events,
    handlers: {
      onOpen: () => events.push("open"),
      onData: (data: Uint8Array) => events.push(`data ${[...data].join(",")}`),
      onEnd: (failure: unknown) => events.push(failure === undefined ? "end" : `failed ${String(failure)}`),
    },
  }
}

describe("streamVmScreen", () => {
  test("reads only after the stream opens, and asks for each byte once", async () => {
    const fake = fakeCalls()
    const { events, handlers } = recorder()
    streamVmScreen(fake.calls, handlers)
    await settled()
    expect(fake.reads).toEqual([])

    fake.opens[0]!.resolve()
    await settled()
    fake.reads[0]!.resolve({ status: "open", data: new Uint8Array([1, 2]) })
    await settled()
    fake.reads[1]!.resolve({ status: "open", data: new Uint8Array() })
    await settled()
    fake.reads[2]!.resolve({ status: "open", data: new Uint8Array([3]) })
    await settled()

    expect(fake.reads.map((read) => read.input)).toEqual([0, 2, 2, 3])
    expect(events).toEqual(["open", "data 1,2", "data 3"])
  })

  test("ends without a failure once the host reports the stream closed", async () => {
    const fake = fakeCalls()
    const { events, handlers } = recorder()
    streamVmScreen(fake.calls, handlers)
    fake.opens[0]!.resolve()
    await settled()
    fake.reads[0]!.resolve({ status: "closed" })
    await settled()

    expect(events).toEqual(["open", "end"])
    expect(fake.reads).toHaveLength(1)
  })

  test("sends typed while a send is in flight go together, in order", async () => {
    const fake = fakeCalls()
    const stream = streamVmScreen(fake.calls, recorder().handlers)
    fake.opens[0]!.resolve()
    await settled()

    stream.send(new Uint8Array([1]))
    stream.send(new Uint8Array([2]))
    stream.send(new Uint8Array([3, 4]))
    await settled()
    expect(fake.sends.map((send) => send.input)).toEqual([[1]])

    fake.sends[0]!.resolve()
    await settled()
    expect(fake.sends.map((send) => send.input)).toEqual([[1], [2, 3, 4]])
  })

  test("sends a copy of the bytes, because the caller reuses its buffer", async () => {
    const fake = fakeCalls()
    const stream = streamVmScreen(fake.calls, recorder().handlers)
    fake.opens[0]!.resolve()
    await settled()

    const buffer = new Uint8Array([5, 6, 7, 8])
    stream.send(new Uint8Array(buffer.buffer, 1, 2))
    buffer.fill(0)
    await settled()

    expect(fake.sends.map((send) => send.input)).toEqual([[6, 7]])
  })

  test("closing asks the host to close and ends after it answers", async () => {
    const fake = fakeCalls()
    const { events, handlers } = recorder()
    const stream = streamVmScreen(fake.calls, handlers)
    fake.opens[0]!.resolve()
    await settled()

    stream.close()
    stream.send(new Uint8Array([1]))
    await settled()
    expect(fake.closes).toHaveLength(1)
    expect(events).toEqual(["open"])

    fake.closes[0]!.resolve()
    fake.reads[0]!.resolve({ status: "open", data: new Uint8Array([9]) })
    await settled()
    expect(events).toEqual(["open", "end"])
    expect(fake.sends).toEqual([])
  })

  test("a failed open ends the stream with the failure", async () => {
    const fake = fakeCalls()
    const { events, handlers } = recorder()
    streamVmScreen(fake.calls, handlers)
    fake.opens[0]!.reject("The VM is not running.")
    await settled()

    expect(events).toEqual(["failed The VM is not running."])
  })
})
