import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import type { RunTurnInput } from "../shared/agent.ts"
import { CodexProvider } from "./agents/codex/index.ts"
import { MuseProvider } from "./agents/muse/index.ts"
import { agentProviders } from "./app.ts"

const dir = mkdtempSync(join(tmpdir(), "kk-mock-agents-"))
const spawned = join(dir, "spawned")
for (const name of ["codex", "muse"]) {
  writeFileSync(join(dir, name), `#!/bin/sh\necho ${name} >> ${spawned}\nexit 1\n`)
  chmodSync(join(dir, name), 0o755)
}
process.env.PATH = `${dir}:${process.env.PATH}`
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const resume = (threadId: string): RunTurnInput => ({
  threadId,
  prompt: "accepted input",
  attachments: [],
  cwd: dir,
  model: "gpt-5.5",
  effort: null,
  fastMode: false,
  autoCompactTokens: null,
  userSkills: false,
  accessMode: "full",
  resumeSessionId: "session-1",
  forkAt: null,
  home: null,
  mcpServer: { url: "http://127.0.0.1:1/mcp", headers: { authorization: "Bearer test" } },
  instructions: "",
})

describe("agentProviders", () => {
  it.live("HINACODE_MOCK_AGENTS resumes Codex and Muse turns in the simulation", () =>
    Effect.gen(function* () {
      const codex = yield* CodexProvider
      const muse = yield* MuseProvider
      const endings = yield* Effect.forEach([codex, muse], (provider) =>
        Stream.runCollect(provider.runTurn(resume(`thread-${provider.id}`))).pipe(
          Effect.map((events) => Array.from(events).at(-1)),
          Effect.orElseSucceed(() => undefined),
        ),
      )
      expect(existsSync(spawned)).toBe(false)
      expect(endings).toEqual([{ type: "turn_completed" }, { type: "turn_completed" }])
    }).pipe(
      Effect.provide(
        Layer.fresh(agentProviders({ HINACODE_MOCK_AGENTS: "usage-limit", HINACODE_USER_DATA: dir }).layer),
      ),
    ),
  )
})
