import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { PushEvent } from "../../shared/contract.ts"
import { onPushEvent } from "./rpc.ts"

let bridgeListeners: ReadonlyArray<(event: unknown) => void> = []
const push = (event: unknown) => {
  for (const listener of bridgeListeners) listener(event)
}

beforeEach(() => {
  vi.stubGlobal("window", {
    hinacode: {
      onEvent: (listener: (event: unknown) => void) => {
        bridgeListeners = [...bridgeListeners, listener]
        return () => {
          bridgeListeners = bridgeListeners.filter((other) => other !== listener)
        }
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  bridgeListeners = []
})

test("listens on the bridge once and hands every listener the same decoded event", () => {
  const received: Array<PushEvent> = []
  const unsubscribes = [1, 2, 3].map(() => onPushEvent((event) => received.push(event)))
  expect(bridgeListeners.length).toBe(1)

  push({ type: "environments.changed" })
  expect(received).toHaveLength(3)
  expect(new Set(received).size).toBe(1)

  for (const unsubscribe of unsubscribes) unsubscribe()
  expect(bridgeListeners.length).toBe(0)
})

test("a listener that resubscribes while handling an event does not see that event again", () => {
  let calls = 0
  const subscribe = (): (() => void) => {
    const unsubscribe = onPushEvent(() => {
      calls++
      unsubscribe()
      stop = subscribe()
    })
    return unsubscribe
  }
  let stop = subscribe()

  push({ type: "environments.changed" })
  expect(calls).toBe(1)
  stop()
})

test("a throwing listener does not stop the others", () => {
  const reportError = vi.fn()
  vi.stubGlobal("reportError", reportError)
  const failure = new Error("listener failed")
  const received: Array<PushEvent> = []
  const stopFailing = onPushEvent(() => {
    throw failure
  })
  const stopReceiving = onPushEvent((event) => received.push(event))

  push({ type: "environments.changed" })
  expect(received).toHaveLength(1)
  expect(reportError).toHaveBeenCalledWith(failure)
  stopFailing()
  stopReceiving()
})
