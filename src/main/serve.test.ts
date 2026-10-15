import { describe, expect, test } from "@effect/vitest"
import { serveConfig } from "./serve.ts"

describe("serveConfig", () => {
  test("stays in desktop mode without the serve command or env", () => {
    expect(serveConfig(["/opt/kkcode/kkcode"], {})).toBeNull()
    expect(serveConfig(["/opt/kkcode/kkcode"], { KKCODE_SERVE: "0" })).toBeNull()
  })

  test("reads the serve command with no overrides", () => {
    expect(serveConfig(["/opt/kkcode/kkcode", "serve"], {})).toStrictEqual({ rotateToken: false })
  })

  test("reads host, port and rotation from the environment", () => {
    expect(
      serveConfig(["/opt/kkcode/kkcode"], {
        KKCODE_SERVE: "1",
        KKCODE_SERVE_HOST: "127.0.0.1",
        KKCODE_SERVE_PORT: "49000",
        KKCODE_SERVE_ROTATE_TOKEN: "true",
      }),
    ).toStrictEqual({ bindHost: "127.0.0.1", port: 49000, rotateToken: true })
  })

  test("flags override the environment", () => {
    expect(
      serveConfig(["/opt/kkcode/kkcode", "serve", "--port=49100", "--host", "0.0.0.0", "--rotate-token"], {
        KKCODE_SERVE_PORT: "49000",
        KKCODE_SERVE_HOST: "127.0.0.1",
      }),
    ).toStrictEqual({ bindHost: "0.0.0.0", port: 49100, rotateToken: true })
  })

  test("refuses a port it cannot listen on", () => {
    expect(() => serveConfig(["kkcode", "serve"], { KKCODE_SERVE_PORT: "abc" })).toThrow(/port/)
    expect(() => serveConfig(["kkcode", "serve", "--port", "70000"], {})).toThrow(/port/)
    expect(() => serveConfig(["kkcode", "serve", "--port", "0"], {})).toThrow(/port/)
  })

  test("refuses an unknown KKCODE_SERVE value instead of guessing", () => {
    expect(() => serveConfig(["kkcode"], { KKCODE_SERVE: "yes" })).toThrow(/KKCODE_SERVE/)
  })
})
