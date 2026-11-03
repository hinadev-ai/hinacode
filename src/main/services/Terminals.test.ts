import { describe, expect, it } from "@effect/vitest"
import { terminalShell } from "./Terminals.ts"

describe("terminalShell", () => {
  const login = (file: string) => ({ file, args: ["-l"] })

  it("prefers SHELL", () => {
    expect(terminalShell("darwin", { SHELL: "/usr/bin/fish" }, "/bin/bash")).toStrictEqual(login("/usr/bin/fish"))
  })

  it("falls back to the account's login shell when SHELL is unset or empty", () => {
    expect(terminalShell("linux", {}, "/bin/bash")).toStrictEqual(login("/bin/bash"))
    expect(terminalShell("linux", { SHELL: "" }, "/bin/bash")).toStrictEqual(login("/bin/bash"))
  })

  it("falls back to /bin/sh when the account has no shell", () => {
    expect(terminalShell("linux", {}, null)).toStrictEqual(login("/bin/sh"))
  })

  it("opens PowerShell on Windows, which also runs in a WSL folder", () => {
    expect(terminalShell("win32", { SHELL: "/usr/bin/bash" }, null)).toStrictEqual({
      file: "powershell.exe",
      args: ["-NoLogo"],
    })
  })
})
