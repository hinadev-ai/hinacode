import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ClaudeProvider, layer } from "./index.ts"

// Stands in for `claude auth login`: prints what the real CLI prints, records its config dir, and
// accepts one pasted code.
const bin = mkdtempSync(join(tmpdir(), "kk-fake-claude-"))
const fakeClaude = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs")
const { createInterface } = require("node:readline")
writeFileSync(process.env.CLAUDE_CONFIG_DIR + "/seen", process.argv.slice(2).join(" "))
process.stdout.write("Opening browser to sign in…\\n")
process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\\n")
process.stdout.write("Paste code here if prompted > ")
createInterface({ input: process.stdin }).once("line", (code) => {
  if (code === "good-code") process.exit(0)
  process.stdout.write("Invalid code\\n")
  process.exit(1)
})
`
writeFileSync(join(bin, "claude"), fakeClaude)
chmodSync(join(bin, "claude"), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`

const signIn = (code: string) =>
  Effect.gen(function* () {
    const home = mkdtempSync(join(tmpdir(), "kk-claude-home-"))
    const provider = yield* ClaudeProvider
    const pending = yield* provider.signIn(home)
    yield* pending.submitCode!(code)
    const outcome = yield* Effect.result(pending.completed)
    return { pending, outcome, seen: readFileSync(join(home, "seen"), "utf8") }
  }).pipe(Effect.scoped, Effect.provide(layer))

describe("Claude sign-in", () => {
  it.live("runs claude auth login in the account's config dir and finishes on the pasted code", () =>
    Effect.gen(function* () {
      const { pending, outcome, seen } = yield* signIn("good-code")
      expect(pending.url).toBe("https://claude.com/cai/oauth/authorize?code=true&state=abc")
      expect(pending.openedBrowser).toBe(true)
      expect(seen).toBe("auth login --claudeai")
      expect(outcome._tag).toBe("Success")
    }),
  )

  it.live("fails with what the CLI printed when the code is wrong", () =>
    Effect.gen(function* () {
      const { outcome } = yield* signIn("bad-code")
      expect(outcome._tag === "Failure" && outcome.failure.message).toContain("Invalid code")
    }),
  )
})
