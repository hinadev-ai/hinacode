import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"
import { suggest } from "./ThreadNaming.ts"

const claudeInstalled = spawnSync("claude", ["--version"]).status === 0

const anthropic = createServer((request, response) => {
  request.resume()
  response.writeHead(400, { "content-type": "application/json" })
  response.end(
    JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is invalid" } }),
  )
})
let configDir = ""

beforeAll(async () => {
  await new Promise<void>((resolve) => anthropic.listen(0, "127.0.0.1", resolve))
  configDir = mkdtempSync(join(tmpdir(), "kk-naming-claude-"))
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir)
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test")
  vi.stubEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}`)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  anthropic.closeAllConnections()
  await new Promise((resolve) => anthropic.close(resolve))
  rmSync(configDir, { recursive: true, force: true })
})

describe.skipIf(!claudeInstalled)("naming a thread with the real Claude Code", () => {
  it.live(
    "reports the API error instead of a schema error when Anthropic refuses the request",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(suggest("claude-haiku-5-5", "Fix the login form"))
        expect(error.message).toBe("Failed to name thread: API Error: 400 prompt is invalid")
      }),
    60_000,
  )
})
