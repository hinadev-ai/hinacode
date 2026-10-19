import { describe, expect, test } from "@effect/vitest"
import { serveConfig } from "./serve.ts"

describe("serveConfig", () => {
  test("reads the serve command with no overrides", () => {
    expect(serveConfig(["serve"], {})).toStrictEqual({ rotateToken: false })
  })

  test("reads host, port and rotation from the environment", () => {
    expect(
      serveConfig(["serve"], {
        HINACODE_SERVE_HOST: "127.0.0.1",
        HINACODE_SERVE_PORT: "49000",
        HINACODE_SERVE_ROTATE_TOKEN: "true",
      }),
    ).toStrictEqual({ bindHost: "127.0.0.1", port: 49000, rotateToken: true })
  })

  test("flags override the environment", () => {
    expect(
      serveConfig(["serve", "--port=49100", "--host", "0.0.0.0", "--rotate-token"], {
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

  test("refuses an unknown HINACODE_SERVE_ROTATE_TOKEN value instead of guessing", () => {
    expect(() => serveConfig(["serve"], { HINACODE_SERVE_ROTATE_TOKEN: "yes" })).toThrow(/HINACODE_SERVE_ROTATE_TOKEN/)
  })
})
