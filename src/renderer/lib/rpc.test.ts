import { AtomRegistry } from "effect/reactivity"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { PushEvent } from "../../shared/contract.ts"
import { onPushEvent, pullRequestStatusAtom } from "./rpc.ts"

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
  vi.useRealTimers()
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

test("pull request polling resumes after the window hides across a refresh and returns before it is stale", async () => {
  vi.useFakeTimers({ now: 40_000 })
  const page = Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible" })
  const setVisible = (visible: boolean) => {
    page.hidden = !visible
    page.visibilityState = visible ? "visible" : "hidden"
    page.dispatchEvent(new Event("visibilitychange"))
  }
  let lookups = 0
  vi.stubGlobal("document", page)
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      hinacode: {
        rpc: async () => {
          lookups++
          return {
            result: {
              url: "https://github.com/o/r/pull/1",
              number: 1,
              title: "Poll",
              status: "open",
              checks: "passing",
              review: null,
              author: "octocat",
              headRefName: "feature",
              baseRefName: "main",
              additions: 1,
              deletions: 0,
            },
          }
        },
      },
    }),
  )
  const registry = AtomRegistry.make()
  const unmount = registry.mount(pullRequestStatusAtom(null, "https://github.com/o/r/pull/1"))
  await vi.advanceTimersByTimeAsync(0)
  expect(lookups).toBe(1)

  setVisible(false)
  await vi.advanceTimersByTimeAsync(21_000)
  setVisible(true)
  expect(lookups).toBe(1)

  await vi.advanceTimersByTimeAsync(60_000)
  expect(lookups).toBe(2)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(lookups).toBe(4)

  unmount()
  registry.dispose()
})
