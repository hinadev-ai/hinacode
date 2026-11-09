import { describe, expect, test } from "@effect/vitest"
import { terminalText } from "./terminalText.ts"

describe("terminalText", () => {
  test("strips colors, titles and mode switches from what a shell prints", () => {
    const raw =
      "\u001B]0;kalan@agent: ~/code\u0007\u001B[?2004h$ ls\r\n\u001B[01;34msrc\u001B[0m  \u001B[32mREADME.md\u001B[0m\r\n\u001B]7;file://agent/home/kalan\u001B\\\u0007$ "
    expect(terminalText(raw, 200, 80)).toBe("$ ls\nsrc  README.md\n$")
  })

  test("drops the command marks the shell integration prints", () => {
    const raw =
      "\u001B]133;A\u0007$ ls -la\r\n\u001B]633;E;ls -la\u0007\u001B]133;C\u0007total 0\r\n\u001B]133;D;0\u0007"
    expect(terminalText(raw, 200, 80)).toBe("$ ls -la\ntotal 0")
  })

  test("keeps only the last state of a line redrawn with carriage returns", () => {
    const raw = "Downloading  10%\rDownloading  55%\rDownloading 100%\r\ndone\r\n"
    expect(terminalText(raw, 200, 80)).toBe("Downloading 100%\ndone")
  })

  test("erases the rest of the line on ESC[K, the way a shell redraws its prompt", () => {
    expect(terminalText("building assets\r\u001B[Kready\r\n$ \r\u001B[K\r$ ", 200, 80)).toBe("ready\n$")
  })

  test("joins a command line zsh wrapped at the right margin with a space and a carriage return", () => {
    const raw = "$ echo 0123456789abc \rdefghij\r\n0123456789abcdefghij\r\n$ "
    expect(terminalText(raw, 200, 20)).toBe("$ echo 0123456789abcdefghij\n0123456789abcdefghij\n$")
  })

  test("drops blank lines at both ends and returns the last lines asked for", () => {
    const raw = `\r\n${Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\r\n")}\r\n\r\n   \r\n`
    expect(terminalText(raw, 3, 80)).toBe("line 8\nline 9\nline 10")
    expect(terminalText(raw, 200, 80).split("\n")[0]).toBe("line 1")
  })

  test("is empty for output with no text", () => {
    expect(terminalText("\u001B[H\u001B[2J\r\n", 200, 80)).toBe("")
  })
})
