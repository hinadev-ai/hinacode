import { describe, expect, test } from "@effect/vitest"
import { serveConfig } from "./serve.ts"

describe("serveConfig", () => {
  test("stays in desktop mode without the serve command or env", () => {
    expect(serveConfig(["/opt/hinacode/hinacode"], {})).toBeNull()
    expect(serveConfig(["/opt/hinacode/hinacode"], { HINACODE_SERVE: "0" })).toBeNull()
  })

  test("reads the serve command with no overrides", () => {
    expect(serveConfig(["/opt/hinacode/hinacode", "serve"], {})).toStrictEqual({ rotateToken: false })
  })

  test("reads host, port and rotation from the environment", () => {
    expect(
      serveConfig(["/opt/hinacode/hinacode"], {
        HINACODE_SERVE: "1",
        HINACODE_SERVE_HOST: "127.0.0.1",
        HINACODE_SERVE_PORT: "49000",
        HINACODE_SERVE_ROTATE_TOKEN: "true",
      }),
    ).toStrictEqual({ bindHost: "127.0.0.1", port: 49000, rotateToken: true })
  })

  test("flags override the environment", () => {
    expect(
      serveConfig(["/opt/hinacode/hinacode", "serve", "--port=49100", "--host", "0.0.0.0", "--rotate-token"], {
        HINACODE_SERVE_PORT: "49000",
        HINACODE_SERVE_HOST: "127.0.0.1",
      }),
    ).toStrictEqual({ bindHost: "0.0.0.0", port: 49100, rotateToken: true })
  })

  test("refuses a port it cannot listen on", () => {
    expect(() => serveConfig(["hinacode", "serve"], { HINACODE_SERVE_PORT: "abc" })).toThrow(/port/)
    expect(() => serveConfig(["hinacode", "serve", "--port", "70000"], {})).toThrow(/port/)
    expect(() => serveConfig(["hinacode", "serve", "--port", "0"], {})).toThrow(/port/)
  })

  test("refuses an unknown HINACODE_SERVE value instead of guessing", () => {
    expect(() => serveConfig(["hinacode"], { HINACODE_SERVE: "yes" })).toThrow(/HINACODE_SERVE/)
  })
})
