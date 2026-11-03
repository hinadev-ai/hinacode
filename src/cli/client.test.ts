import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "@effect/vitest"
import { Effect, Option, Queue, type Scope } from "effect"
import { WebSocketServer } from "ws"
import { REMOTE_PATH, type ServerFrame } from "../shared/remote.ts"
import { connect, RpcError } from "./client.ts"
import { CliFailure, EXIT } from "./exit.ts"
import { connectFirst, NOT_RUNNING } from "./target.ts"

type Frame = Record<string, unknown>

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const listen = async (greeting: typeof ServerFrame.Encoded, answer: (frame: Frame) => ReadonlyArray<Frame>) => {
  const dir = mkdtempSync(join(tmpdir(), "hinacode-cli-"))
  const socketPath = join(dir, "cli.sock")
  const http = createServer()
  const wss = new WebSocketServer({ server: http, path: REMOTE_PATH })
  const received: Array<Frame> = []
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify(greeting))
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Frame
      received.push(frame)
      for (const reply of answer(frame)) socket.send(JSON.stringify(reply))
    })
  })
  await new Promise<void>((resolve) => http.listen(socketPath, resolve))
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => http.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })
  return { socketPath, received }
}

const ready = { type: "ready", version: 1, features: ["call-keys", "watch"] } as const

const THREAD = {
  id: "a41f0c2e-1111-4aaa-8bbb-000000000001",
  projectId: "p1",
  worktreeId: null,
  title: "fix-login",
  provider: "claude",
  model: "m",
  effort: null,
  fastMode: false,
  accessMode: "auto",
  accountId: null,
  providerSessionId: null,
  status: "running",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  queue: [],
  scheduled: [],
  createdBy: "user",
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
}

const answerCalls = (frame: Frame): ReadonlyArray<Frame> => {
  if (frame["type"] === "watch") return [{ type: "event", event: { type: "thread.removed", id: "t1" } }]
  if (frame["type"] !== "call") return []
  const id = frame["id"]
  switch (frame["method"]) {
    case "threads.list":
      return [{ type: "result", id, envelope: { result: [THREAD] } }]
    case "threads.interrupt":
      return [{ type: "result", id, envelope: {} }]
    default:
      return [{ type: "result", id, envelope: { error: { tag: "ThreadNotFound", message: "no such thread" } } }]
  }
}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

describe("connect", () => {
  test("decodes a read's result and sends it without an idempotency key", async () => {
    const { socketPath, received } = await listen(ready, answerCalls)
    const threads = await run(Effect.flatMap(connect(socketPath), (client) => client.call("threads.list", undefined)))
    expect(threads.map((thread) => [thread.title, thread.userSkills, thread.sideOf])).toStrictEqual([
      ["fix-login", true, null],
    ])
    expect(received).toStrictEqual([{ type: "call", id: 1, method: "threads.list" }])
  })

  test("gives every mutation its own key", async () => {
    const { socketPath, received } = await listen(ready, answerCalls)
    await run(
      Effect.gen(function* () {
        const client = yield* connect(socketPath)
        yield* client.call("threads.interrupt", { threadId: "t1" })
        yield* client.call("threads.interrupt", { threadId: "t1" })
      }),
    )
    const keys = received.map((frame) => frame["key"])
    expect(received.map((frame) => frame["payload"])).toStrictEqual([{ threadId: "t1" }, { threadId: "t1" }])
    expect(keys.every((key) => typeof key === "string" && key.length > 0)).toBe(true)
    expect(keys[0]).not.toBe(keys[1])
  })

  test("turns an error envelope into an RpcError with the server's tag", async () => {
    const { socketPath } = await listen(ready, answerCalls)
    const error = await run(
      Effect.flatMap(connect(socketPath), (client) =>
        Effect.flip(client.call("threads.transcript", { threadId: "missing" })),
      ),
    )
    expect(error).toStrictEqual(new RpcError({ tag: "ThreadNotFound", message: "no such thread" }))
  })

  test("streams the events the server pushes after a watch", async () => {
    const { socketPath, received } = await listen(ready, answerCalls)
    const [event] = await run(
      Effect.gen(function* () {
        const client = yield* connect(socketPath)
        const events = yield* client.subscribe
        yield* client.watch(["t1"])
        return [Option.some(yield* Queue.take(events))]
      }),
    )
    expect(event).toStrictEqual(Option.some({ type: "thread.removed", id: "t1" }))
    expect(received).toStrictEqual([{ type: "watch", threadIds: ["t1"] }])
  })

  test("refuses a socket that asks for a token, because that is a remote listener", async () => {
    const { socketPath } = await listen({ type: "challenge", nonce: "n" }, () => [])
    const error = await run(Effect.flip(connect(socketPath)))
    expect(error).toBeInstanceOf(CliFailure)
    expect(error).toMatchObject({ code: EXIT.unreachable, message: expect.stringMatching(/asks for a token/) })
  })
})

describe("connectFirst", () => {
  test("skips sockets nobody listens on and uses the first live one", async () => {
    const { socketPath } = await listen(ready, answerCalls)
    const missing = join(tmpdir(), "hinacode-cli-missing", "cli.sock")
    const client = await run(Effect.map(connectFirst([missing, socketPath]), (live) => live.socketPath))
    expect(client).toBe(socketPath)
  })

  test("exits unreachable when no HinaCode runs", async () => {
    const error = await run(Effect.flip(connectFirst([join(tmpdir(), "hinacode-cli-missing", "cli.sock")])))
    expect(error).toStrictEqual(new CliFailure({ code: EXIT.unreachable, message: NOT_RUNNING }))
  })
})
