import { expect, test } from "@effect/vitest"
import { ownToolName, unwrapShell } from "./toolNames.ts"

test("strips the prefixes Claude and opencode put on HinaCode's own tools", () => {
  expect(ownToolName("mcp__hinacode__create_thread")).toBe("create_thread")
  expect(ownToolName("hinacode_list_threads")).toBe("list_threads")
  expect(ownToolName("hinacode/read_thread")).toBe("read_thread")
  expect(ownToolName("mcp__other__create_thread")).toBe("mcp__other__create_thread")
})

test("unwraps the login shell Codex runs every command in", () => {
  expect(unwrapShell("/bin/zsh -lc 'pnpm test'")).toBe("pnpm test")
  expect(unwrapShell("bash -c 'echo '\\''hi'\\'''")).toBe("echo 'hi'")
  expect(unwrapShell("sh -c 'ls'")).toBe("ls")
  expect(unwrapShell("pnpm test")).toBe("pnpm test")
  expect(unwrapShell("/bin/zsh -lc 'echo hi")).toBe("/bin/zsh -lc 'echo hi")
})
