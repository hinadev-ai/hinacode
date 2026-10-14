import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { ClaudeProvider, layer } from "./index.ts"

const fake = vi.hoisted(() => ({
  info: {} as unknown,
  reject: false,
  pending: false,
  close: vi.fn(),
  query: vi.fn(),
}))
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (input: unknown) => {
    fake.query(input)
    return {
      accountInfo: () =>
        fake.pending
          ? new Promise(() => {})
          : fake.reject
            ? Promise.reject(new Error("probe failed"))
            : Promise.resolve(fake.info),
      close: fake.close,
    }
  },
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(),
}))

const probeEnv = () => (fake.query.mock.calls[0]![0] as { options: { env: Record<string, string> } }).options.env

const read = Effect.gen(function* () {
  const provider = yield* ClaudeProvider
  return yield* provider.account(null)
}).pipe(Effect.provide(layer))

describe("Claude account probe", () => {
  const cases = [
    [{}, { type: "signedOut" }],
    [{ apiKeySource: "env", tokenSource: "secret" }, { type: "apiKey" }],
    [
      { apiProvider: "firstParty", email: "dev@example.com", subscriptionType: "Claude Max", organization: "Example" },
      { type: "subscription", email: "dev@example.com", plan: "Claude Max", organization: "Example" },
    ],
    [{ subscriptionType: "Claude Pro" }, { type: "subscription", email: null, plan: "Claude Pro", organization: null }],
    [{ apiProvider: "bedrock" }, { type: "external", service: "Amazon Bedrock" }],
    [{ apiProvider: "vertex" }, { type: "external", service: "Google Vertex AI" }],
    [{ apiProvider: "gateway" }, { type: "external", service: "an enterprise gateway" }],
  ]
  for (const [info, expected] of cases) {
    it.effect(`normalizes ${JSON.stringify(info)} and closes its isolated probe`, () =>
      Effect.gen(function* () {
        fake.info = info
        fake.reject = false
        fake.pending = false
        fake.close.mockClear()
        fake.query.mockClear()
        expect(yield* read).toStrictEqual(expected)
        expect(fake.close).toHaveBeenCalledOnce()
        expect(fake.query.mock.calls[0]?.[0]).toMatchObject({ options: { settingSources: [], persistSession: false } })
      }),
    )
  }
  it.effect("reads an added account from its own config dir", () =>
    Effect.gen(function* () {
      fake.info = { email: "work@example.com" }
      fake.query.mockClear()
      const provider = yield* ClaudeProvider
      yield* provider.account({ dir: "/accounts/work", binary: "claude" })
      const env = probeEnv()
      expect(env.CLAUDE_CONFIG_DIR).toBe("/accounts/work")
      fake.query.mockClear()
      yield* provider.account(null)
      const defaultEnv = probeEnv()
      expect(defaultEnv.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR)
    }).pipe(Effect.provide(layer)),
  )
  it.effect("closes a rejected probe", () =>
    Effect.gen(function* () {
      fake.reject = true
      fake.close.mockClear()
      expect((yield* read.pipe(Effect.flip)).message).toContain("probe failed")
      expect(fake.close).toHaveBeenCalledOnce()
      fake.reject = false
    }),
  )
  it.effect("closes a timed out probe", () =>
    Effect.gen(function* () {
      fake.pending = true
      fake.close.mockClear()
      const fiber = yield* read.pipe(Effect.forkChild)
      yield* TestClock.adjust("31 seconds")
      expect((yield* Fiber.join(fiber).pipe(Effect.flip)).message).toContain("timed out")
      expect(fake.close).toHaveBeenCalledOnce()
      fake.pending = false
    }),
  )
  for (const info of [{ email: 123 }, { apiProvider: "futureProvider" }]) {
    it.effect(`rejects invalid account metadata ${JSON.stringify(info)}`, () =>
      Effect.gen(function* () {
        fake.info = info
        fake.pending = false
        const error = yield* read.pipe(Effect.flip)
        expect(error._tag).toBe("AgentError")
        expect(error.message).toMatch(/invalid response/)
      }),
    )
  }
})
