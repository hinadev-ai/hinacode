import { describe, expect, test } from "vitest"
import { formatEnvLines, parseEnvLines } from "./envLines.ts"

describe("parseEnvLines", () => {
  test("reads variables and skips blank lines and comments", () => {
    expect(parseEnvLines("# api\nAPI_URL=https://x.test/?a=b\n\n  DEBUG=  \n")).toEqual({
      env: { API_URL: "https://x.test/?a=b", DEBUG: "" },
    })
  })

  test.each([
    ["A=1\nnot a variable", 2],
    ["=value", 1],
    ["1ABC=x", 1],
    ["MY-VAR=x", 1],
  ])("rejects %j at line %i", (text, invalidLine) => {
    expect(parseEnvLines(text)).toEqual({ invalidLine })
  })

  test("round-trips through formatEnvLines", () => {
    const env = { A: "1", B: "x=y" }
    expect(parseEnvLines(formatEnvLines(env))).toEqual({ env })
  })
})
