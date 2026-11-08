import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { RunTurnInput } from "../../../shared/agent.ts"
import { mockModel } from "./fixtures/sdk.ts"
import { ClaudeProvider } from "./index.ts"
import { usageLimitLayer } from "./mock.ts"

const turnInput = (prompt: string): RunTurnInput => ({
  threadId: "thread-1",
  prompt,
  attachments: [],
  cwd: "/tmp",
  tmpDirectory: null,
  model: mockModel,
  effort: null,
  fastMode: false,
  autoCompactTokens: null,
  accessMode: "supervised",
  resumeSessionId: null,
  forkAt: null,
  home: null,
  mcpServer: { url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer mock" } },
  instructions: "",
})

describe("mock Claude", () => {
  it.live("binds a session on a played turn, so the next message reaches the mock as typed", () =>
    Effect.gen(function* () {
      const claude = yield* ClaudeProvider
      const events = yield* Stream.runCollect(claude.runTurn(turnInput("/mock-error")))
      expect(events.filter((event) => event.type === "session_bound")).toHaveLength(1)
    }).pipe(Effect.provide(usageLimitLayer("thinking"))),
  )
})
