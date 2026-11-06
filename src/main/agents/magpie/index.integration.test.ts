import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { RunTurnInput } from "../../../shared/agent.ts"
import { MAGPIE_KEY } from "./gateway.ts"
import { MagpieProvider } from "./index.ts"

const FAST_MODEL = "codex/gpt-6.1-sol"
const PLAIN_MODEL = "anthropic/claude-haiku-5-5"

interface MessagesRequest {
  readonly model: string
  readonly speed: string | null
  readonly key: string | undefined
}

const requests: Array<MessagesRequest> = []

const sse = (response: ServerResponse, model: string) => {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  response.end()
}

const answerMessages = (request: IncomingMessage, response: ServerResponse, text: string) => {
  const body = JSON.parse(text) as { model: string; speed?: string; stream?: boolean }
  requests.push({
    model: body.model,
    speed: body.speed ?? null,
    key: request.headers.authorization?.replace(/^Bearer /, "") ?? request.headers["x-api-key"]?.toString(),
  })
  if (body.stream) return sse(response, body.model)
  response.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "pong" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  )
}

const gateway = createServer((request, response) => {
  const chunks: Array<Buffer> = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    const path = request.url?.split("?")[0]
    if (path === "/api/hello") return response.end(JSON.stringify({ name: "magpie", version: "test" }))
    if (path === "/v1/models")
      return response.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: FAST_MODEL, display_name: "GPT-6.1-Sol", service_tiers: [{ id: "priority", name: "Fast" }] },
            { id: PLAIN_MODEL, display_name: "Claude Haiku 5.5" },
          ],
        }),
      )
    if (path === "/v1/messages") return answerMessages(request, response, Buffer.concat(chunks).toString())
    response.writeHead(404).end()
  })
})

const claudeInstalled = spawnSync("claude", ["--version"]).status === 0
const saved = { XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"], CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] }
let root = ""

const restore = (name: keyof typeof saved) => {
  if (saved[name] === undefined) delete process.env[name]
  else process.env[name] = saved[name]
}

beforeAll(async () => {
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve))
  root = mkdtempSync(join(tmpdir(), "kk-magpie-provider-"))
  mkdirSync(join(root, "config", "magpie"), { recursive: true })
  mkdirSync(join(root, "claude"))
  mkdirSync(join(root, "work"))
  writeFileSync(
    join(root, "config", "magpie", "settings.json"),
    JSON.stringify({ port: (gateway.address() as AddressInfo).port }),
  )
  process.env["XDG_CONFIG_HOME"] = join(root, "config")
  process.env["CLAUDE_CONFIG_DIR"] = join(root, "claude")
})

afterAll(async () => {
  restore("XDG_CONFIG_HOME")
  restore("CLAUDE_CONFIG_DIR")
  gateway.closeAllConnections()
  await new Promise((resolve) => gateway.close(resolve))
  rmSync(root, { recursive: true, force: true })
})

const turn = (overrides: Partial<RunTurnInput>): RunTurnInput => ({
  threadId: "thread-1",
  prompt: "Reply with just: pong",
  attachments: [],
  cwd: join(root, "work"),
  tmpDirectory: null,
  model: FAST_MODEL,
  effort: null,
  fastMode: false,
  autoCompactTokens: null,
  userSkills: true,
  accessMode: "full",
  resumeSessionId: null,
  forkAt: null,
  home: null,
  mcpServer: { url: "http://127.0.0.1:1/mcp", headers: { authorization: "Bearer test" } },
  instructions: "",
  ...overrides,
})

const speedsOf = (input: RunTurnInput) =>
  Effect.gen(function* () {
    requests.length = 0
    const provider = yield* MagpieProvider
    const events = yield* provider.runTurn(input).pipe(Stream.runCollect)
    expect(events.at(-1)?.type).toBe("turn_completed")
    expect(requests.length).toBeGreaterThan(0)
    expect(new Set(requests.map((request) => request.model))).toStrictEqual(new Set([input.model]))
    expect(new Set(requests.map((request) => request.key))).toStrictEqual(new Set([MAGPIE_KEY]))
    return new Set(requests.map((request) => request.speed))
  })

describe("magpie provider against a gateway", () => {
  it.effect("offers fast mode only on a model the gateway serves in its priority tier", () =>
    Effect.gen(function* () {
      const provider = yield* MagpieProvider
      expect((yield* provider.listModels).map((model) => [model.id, model.fastMode])).toStrictEqual([
        [FAST_MODEL, true],
        [PLAIN_MODEL, false],
      ])
      expect(yield* provider.account(null)).toStrictEqual({ type: "external", service: "magpie" })
    }).pipe(Effect.provide(MagpieProvider.layer)),
  )

  it.effect.skipIf(!claudeInstalled)(
    "makes Claude Code ask for the fast speed on every request while the thread is fast, and stop when it is not",
    () =>
      Effect.gen(function* () {
        expect(yield* speedsOf(turn({ fastMode: true }))).toStrictEqual(new Set(["fast"]))
        expect(yield* speedsOf(turn({ fastMode: false }))).toStrictEqual(new Set([null]))
      }).pipe(Effect.provide(MagpieProvider.layer)),
    90_000,
  )

  it.effect.skipIf(!claudeInstalled)(
    "sends no speed to a model without a fast tier, which Anthropic would refuse with a 400",
    () =>
      Effect.gen(function* () {
        expect(yield* speedsOf(turn({ threadId: "thread-2", model: PLAIN_MODEL, fastMode: true }))).toStrictEqual(
          new Set([null]),
        )
      }).pipe(Effect.provide(MagpieProvider.layer)),
    90_000,
  )
})
