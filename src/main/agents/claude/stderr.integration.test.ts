import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { AccountHome, RunTurnInput } from "../../../shared/agent.ts"
import { makeClaudeHarness } from "./index.ts"

const fakeHome = (): AccountHome => {
  const dir = mkdtempSync(join(tmpdir(), "hc-claude-stderr-"))
  const binary = join(dir, "claude")
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fakeCli.mjs")}" "$@"\n`)
  chmodSync(binary, 0o755)
  return { dir, binary }
}

const input = (home: AccountHome, prompt: string): RunTurnInput => ({
  threadId: "t1",
  prompt,
  attachments: [],
  cwd: tmpdir(),
  tmpDirectory: null,
  model: "claude-sonnet-5-5",
  effort: null,
  fastMode: false,
  autoCompactTokens: null,
  accessMode: "supervised",
  resumeSessionId: null,
  forkAt: null,
  home,
  mcpServer: { url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer test" } },
  instructions: "You run inside HinaCode.",
})

const harness = () =>
  makeClaudeHarness({
    id: "claude",
    listModels: Effect.succeed([]),
    launchEnv: () => Effect.succeed({}),
  })

describe("Claude Code stderr", () => {
  it.live("ends a crashed turn with the exit code and the CLI's last stderr lines", () =>
    Effect.gen(function* () {
      const provider = yield* harness()
      const events = yield* Stream.runCollect(provider.runTurn(input(fakeHome(), "crash")))
      expect(Array.from(events).at(-1)).toStrictEqual({
        type: "turn_failed",
        message:
          "Claude Code stream failed: Claude Code process exited with code 3. stderr: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      })
    }).pipe(Effect.scoped),
  )

  it.live("waits for stderr to drain before ending a crashed turn", () =>
    Effect.gen(function* () {
      const provider = yield* harness()
      const events = yield* Stream.runCollect(provider.runTurn(input(fakeHome(), "crash with a late stderr line")))
      const last = Array.from(events).at(-1)
      if (last?.type !== "turn_failed") throw new Error(`expected a failed turn, got ${last?.type}`)
      expect(last.message).toContain("late stderr line")
    }).pipe(Effect.scoped),
  )
})
