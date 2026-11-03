import { AtomRegistry } from "effect/reactivity"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { PushEvent } from "../../shared/contract.ts"
import { branchPullRequestAtom, onPushEvent, pullRequestDetailAtom, pullRequestStatusAtom } from "./rpc.ts"

let bridgeListeners: ReadonlyArray<(event: unknown) => void> = []
const push = (event: unknown) => {
  for (const listener of bridgeListeners) listener(event)
}

const onEvent = (listener: (event: unknown) => void) => {
  bridgeListeners = [...bridgeListeners, listener]
  return () => {
    bridgeListeners = bridgeListeners.filter((other) => other !== listener)
  }
}

const PULL_REQUEST = {
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
}

beforeEach(() => {
  vi.stubGlobal("window", { hinacode: { onEvent } })
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

test("a transcript push that fails to decode asks for a resync and keeps the listener alive", () => {
  const reportError = vi.fn()
  vi.stubGlobal("reportError", reportError)
  const received: Array<unknown> = []
  const stop = onPushEvent((event) => received.push(event))

  push({ type: "thread.event", seq: 4, threadId: "t1", event: { type: "not an agent event" } })
  push({ type: "message.updated", seq: 5, message: { threadId: "t2" } })
  push({ type: "not a push event" })
  push({ type: "environments.changed" })

  expect(received).toStrictEqual([
    { type: "transcript.lost", threadId: "t1" },
    { type: "transcript.lost", threadId: "t2" },
    { type: "environments.changed" },
  ])
  expect(reportError).toHaveBeenCalledTimes(3)
  stop()
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
        onEvent,
        rpc: async () => {
          lookups++
          return { result: PULL_REQUEST }
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

test("a pull request lookup reads again when main says that pull request changed", async () => {
  let lookups = 0
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible" }))
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      hinacode: {
        onEvent,
        rpc: async () => {
          lookups++
          return { result: PULL_REQUEST }
        },
      },
    }),
  )
  const registry = AtomRegistry.make()
  const unmount = registry.mount(pullRequestStatusAtom(null, PULL_REQUEST.url))
  await vi.waitFor(() => expect(lookups).toBe(1))

  push({ type: "github.pullRequest", url: "https://github.com/o/r/pull/2" })
  push({ type: "github.pullRequest", url: PULL_REQUEST.url })
  await vi.waitFor(() => expect(lookups).toBe(2))

  unmount()
  registry.dispose()
})

test("a branch's pull request reads again when main says it changed, from the first lookup on", async () => {
  let lookups = 0
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible" }))
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      hinacode: {
        onEvent,
        rpc: async () => {
          lookups++
          return { result: PULL_REQUEST }
        },
      },
    }),
  )
  const registry = AtomRegistry.make()
  const branch = branchPullRequestAtom("worktree-1")
  const unmount = registry.mount(branch)
  await vi.waitFor(() => expect(registry.get(branch)).toMatchObject({ _tag: "Success", waiting: false }))
  expect(lookups).toBe(1)

  push({ type: "github.pullRequest", url: PULL_REQUEST.url })
  await vi.waitFor(() => expect(lookups).toBe(2))

  unmount()
  registry.dispose()
})

test("returning to the window asks main once for a fresh read of the pull request on screen", async () => {
  const payloads: Array<unknown> = []
  const page = Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible" })
  const app = Object.assign(new EventTarget(), {
    hinacode: {
      onEvent,
      rpc: async (_method: string, payload: unknown) => {
        payloads.push(payload)
        return { result: PULL_REQUEST }
      },
    },
  })
  vi.stubGlobal("document", page)
  vi.stubGlobal("window", app)
  const registry = AtomRegistry.make()
  const unmount = registry.mount(pullRequestDetailAtom(null, PULL_REQUEST.url))
  await vi.waitFor(() => expect(payloads).toHaveLength(1))

  app.dispatchEvent(new Event("blur"))
  app.dispatchEvent(new Event("focus"))
  await vi.waitFor(() => expect(payloads).toHaveLength(2))
  expect(payloads.at(-1)).toStrictEqual({ url: PULL_REQUEST.url, fresh: true })

  unmount()
  registry.dispose()
})
