import { describe, expect, test } from "@effect/vitest"
import { autoUpdate, browserCommand, linkInstructions, restartCommand, serveConfig } from "./serve.ts"

const none = { rotateToken: false }

describe("serveConfig", () => {
  test("reads the serve command with no overrides", () => {
    expect(serveConfig(none, {})).toStrictEqual({ rotateToken: false })
  })

  test("reads host, port and rotation from the environment", () => {
    expect(
      serveConfig(none, {
        HINACODE_SERVE_HOST: "127.0.0.1",
        HINACODE_SERVE_PORT: "49000",
        HINACODE_SERVE_ROTATE_TOKEN: "true",
      }),
    ).toStrictEqual({ bindHost: "127.0.0.1", port: 49000, rotateToken: true })
  })

  test("flags override the environment", () => {
    expect(
      serveConfig(
        { port: 49100, host: "100.64.0.2", rotateToken: true },
        { HINACODE_SERVE_PORT: "49000", HINACODE_SERVE_HOST: "127.0.0.1" },
      ),
    ).toStrictEqual({ bindHost: "100.64.0.2", port: 49100, rotateToken: true })
  })

  test("refuses a host that would listen on every network", () => {
    expect(() => serveConfig({ ...none, host: "0.0.0.0" }, {})).toThrow(/every network/)
    expect(() => serveConfig(none, { HINACODE_SERVE_HOST: "::" })).toThrow(/every network/)
  })

  test("refuses a port it cannot listen on", () => {
    expect(() => serveConfig(none, { HINACODE_SERVE_PORT: "abc" })).toThrow(/port/)
    expect(() => serveConfig({ ...none, port: 70000 }, {})).toThrow(/port/)
    expect(() => serveConfig({ ...none, port: 0 }, {})).toThrow(/port/)
  })

  test("reads the relay switch from the flag before the environment", () => {
    expect(serveConfig({ ...none, relay: "on" }, { HINACODE_SERVE_RELAY: "off" })).toStrictEqual({
      rotateToken: false,
      relay: "on",
    })
    expect(serveConfig(none, { HINACODE_SERVE_RELAY: "off" })).toStrictEqual({ rotateToken: false, relay: "off" })
    expect(serveConfig({ ...none, relay: "off" }, { HINACODE_SERVE_RELAY: "1" })).toStrictEqual({
      rotateToken: false,
      relay: "off",
    })
  })

  test("refuses a relay value other than on or off", () => {
    expect(() => serveConfig(none, { HINACODE_SERVE_RELAY: "1" })).toThrow("HINACODE_SERVE_RELAY must be on or off")
  })

  test("refuses an unknown HINACODE_SERVE_ROTATE_TOKEN value instead of guessing", () => {
    expect(() => serveConfig(none, { HINACODE_SERVE_ROTATE_TOKEN: "yes" })).toThrow(/HINACODE_SERVE_ROTATE_TOKEN/)
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

describe("browserCommand", () => {
  const url = "https://relay.test/link?code=abc"

  test("opens the browser on a machine with a display", () => {
    expect(browserCommand(url, "darwin", {})).toStrictEqual({ file: "open", args: [url] })
    expect(browserCommand(url, "linux", { DISPLAY: ":0" })).toStrictEqual({ file: "xdg-open", args: [url] })
    expect(browserCommand(url, "linux", { WAYLAND_DISPLAY: "wayland-0" })).toStrictEqual({
      file: "xdg-open",
      args: [url],
    })
    expect(browserCommand(url, "win32", {})?.file).toBe("rundll32")
  })

  test("leaves it to the person on a headless machine or over SSH", () => {
    expect(browserCommand(url, "linux", {})).toBeNull()
    expect(browserCommand(url, "linux", { DISPLAY: ":0", SSH_CONNECTION: "1 2 3 4" })).toBeNull()
    expect(browserCommand(url, "darwin", { SSH_TTY: "/dev/ttys001" })).toBeNull()
  })

  test("opens nothing but a web page, whatever the relay answers", () => {
    expect(browserCommand("file:///etc/passwd", "darwin", {})).toBeNull()
    expect(browserCommand("not a url", "darwin", {})).toBeNull()
  })

  test("passes the normalized URL, so a stray byte cannot make spawning throw", () => {
    const args = browserCommand("https://relay.test/link?code=a\0b", "darwin", {})?.args ?? []
    expect(args).toStrictEqual(["https://relay.test/link?code=a%00b"])
  })
})

test("linkInstructions puts the URL on its own line, so it can be clicked or copied", () => {
  expect(linkInstructions("https://relay.test/link?code=abc").split("\n")).toContain(
    "  https://relay.test/link?code=abc",
  )
})
