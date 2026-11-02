import { describe, expect, it } from "@effect/vitest"
import { terminalShell } from "./Terminals.ts"

describe("terminalShell", () => {
  it("prefers SHELL", () => {
    expect(terminalShell({ SHELL: "/usr/bin/fish" }, "/bin/bash")).toBe("/usr/bin/fish")
  })

  it("falls back to the account's login shell when SHELL is unset or empty", () => {
    expect(terminalShell({}, "/bin/bash")).toBe("/bin/bash")
    expect(terminalShell({ SHELL: "" }, "/bin/bash")).toBe("/bin/bash")
  })

  it("falls back to /bin/sh when the account has no shell", () => {
    expect(terminalShell({}, null)).toBe("/bin/sh")
  })
})
