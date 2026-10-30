import { describe, expect, test } from "@effect/vitest"
import { autoUpdate, parseCommand, restartCommand, serveConfig } from "./serve.ts"

describe("parseCommand", () => {
  test("asks for help instead of starting a daemon", () => {
    expect(parseCommand(["serve", "--help"])).toBe("help")
    expect(parseCommand(["serve", "--port", "1", "-h"])).toBe("help")
    expect(parseCommand(["--help"])).toBe("help")
  })

  test("reads serve and pair with their options", () => {
    expect(parseCommand(["serve", "--port", "49000", "--host=100.64.0.2", "--rotate-token"])).toBe("serve")
    expect(parseCommand(["pair"])).toBe("pair")
    expect(parseCommand(["--version"])).toBe("version")
  })

  test("refuses an unknown option instead of ignoring it", () => {
    expect(() => parseCommand(["serve", "--prot", "1"])).toThrow("unknown option --prot")
    expect(() => parseCommand(["serve", "--prot=1"])).toThrow("unknown option --prot")
    expect(() => parseCommand(["pair", "--port", "1"])).toThrow("unknown option --port")
    expect(() => parseCommand(["serve", "extra"])).toThrow("unexpected argument extra")
  })

  test("refuses a missing or unknown command", () => {
    expect(() => parseCommand([])).toThrow("missing command")
    expect(() => parseCommand(["start"])).toThrow("unknown command start")
  })
})

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
      serveConfig(["serve", "--port=49100", "--host", "100.64.0.2", "--rotate-token"], {
        HINACODE_SERVE_PORT: "49000",
        HINACODE_SERVE_HOST: "127.0.0.1",
      }),
    ).toStrictEqual({ bindHost: "100.64.0.2", port: 49100, rotateToken: true })
  })

  test("refuses a host that would listen on every network", () => {
    expect(() => serveConfig(["serve", "--host", "0.0.0.0"], {})).toThrow(/every network/)
    expect(() => serveConfig(["serve"], { HINACODE_SERVE_HOST: "::" })).toThrow(/every network/)
  })

  test("refuses a port it cannot listen on", () => {
    expect(() => serveConfig(["hinacode", "serve"], { HINACODE_SERVE_PORT: "abc" })).toThrow(/port/)
    expect(() => serveConfig(["hinacode", "serve", "--port", "70000"], {})).toThrow(/port/)
    expect(() => serveConfig(["hinacode", "serve", "--port", "0"], {})).toThrow(/port/)
  })

  test("reads the relay switch from the flag before the environment", () => {
    expect(serveConfig(["serve", "--relay", "on"], { HINACODE_SERVE_RELAY: "off" })).toStrictEqual({
      rotateToken: false,
      relay: "on",
    })
    expect(serveConfig(["serve"], { HINACODE_SERVE_RELAY: "off" })).toStrictEqual({ rotateToken: false, relay: "off" })
    expect(serveConfig(["serve", "--relay=off"], {})).toStrictEqual({ rotateToken: false, relay: "off" })
    expect(parseCommand(["serve", "--relay", "on"])).toBe("serve")
  })

  test("refuses a relay value other than on or off", () => {
    expect(() => serveConfig(["serve", "--relay", "example.com"], {})).toThrow("--relay must be on or off")
    expect(() => serveConfig(["serve"], { HINACODE_SERVE_RELAY: "1" })).toThrow(
      "HINACODE_SERVE_RELAY must be on or off",
    )
    expect(() => serveConfig(["serve", "--relay"], {})).toThrow("--relay needs a value")
  })

  test("refuses an unknown HINACODE_SERVE_ROTATE_TOKEN value instead of guessing", () => {
    expect(() => serveConfig(["serve"], { HINACODE_SERVE_ROTATE_TOKEN: "yes" })).toThrow(/HINACODE_SERVE_ROTATE_TOKEN/)
  })
})

describe("autoUpdate", () => {
  test("is on unless the environment turns it off", () => {
    expect(autoUpdate({})).toBe(true)
    expect(autoUpdate({ HINACODE_SERVE_AUTO_UPDATE: "1" })).toBe(true)
    expect(autoUpdate({ HINACODE_SERVE_AUTO_UPDATE: "0" })).toBe(false)
    expect(autoUpdate({ HINACODE_SERVE_AUTO_UPDATE: "false" })).toBe(false)
  })

  test("refuses a value it does not understand", () => {
    expect(() => autoUpdate({ HINACODE_SERVE_AUTO_UPDATE: "yes" })).toThrow("HINACODE_SERVE_AUTO_UPDATE must be 1 or 0")
  })
})

describe("restartCommand", () => {
  const running = {
    execPath: "/usr/bin/node",
    execArgv: ["--enable-source-maps"],
    argv: ["/usr/bin/node", "/opt/hinacode/bin/hinacode", "serve", "--rotate-token", "--port", "47441"],
    env: { PATH: "/usr/bin", HINACODE_SERVE_ROTATE_TOKEN: "1", HINACODE_USER_DATA: "/srv/cloud" },
  }

  test("boots the same command with the same node flags", () => {
    expect(restartCommand(running)).toMatchObject({
      file: "/usr/bin/node",
      args: ["/usr/bin/node", "--enable-source-maps", "/opt/hinacode/bin/hinacode", "serve", "--port", "47441"],
    })
  })

  test("does not rotate the token again, so paired clients stay paired", () => {
    const { args, env } = restartCommand(running)
    expect(args).not.toContain("--rotate-token")
    expect(env).toStrictEqual({ PATH: "/usr/bin", HINACODE_USER_DATA: "/srv/cloud" })
  })
})
