import { describe, expect, it, test } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { launchdPlist, serveCommand, systemdUnit } from "./service.ts"

const spec = {
  command: ["/Users/k & co/.local/bin/hinacode", "serve"],
  env: { PATH: "/opt/homebrew/bin:/usr/bin", HINACODE_USER_DATA: "/Users/k & co/.hinacode-cloud" },
  home: "/Users/k & co",
}

describe("launchdPlist", () => {
  test("runs serve with the install's PATH and data, keeps it alive, and names its log to serve", () => {
    expect(launchdPlist(spec, "/Users/k & co/Library/Logs/hinacode/serve.log")).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.hinacode.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/k &amp; co/.local/bin/hinacode</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin</string>
    <key>HINACODE_USER_DATA</key>
    <string>/Users/k &amp; co/.hinacode-cloud</string>
    <key>HINACODE_SERVE_LOG</key>
    <string>/Users/k &amp; co/Library/Logs/hinacode/serve.log</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/k &amp; co</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/k &amp; co/Library/Logs/hinacode/serve.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/k &amp; co/Library/Logs/hinacode/serve.log</string>
</dict>
</plist>
`,
    )
  })
})

describe("systemdUnit", () => {
  test("quotes words so spaces, quotes, % and $ reach serve as written", () => {
    const unit = systemdUnit({
      command: ['/home/k "dev"/50% $HOME/hinacode', "serve"],
      env: { PATH: "/home/k/.local/bin:/usr/bin", HINACODE_USER_DATA: "/home/k/100%" },
      home: "/home/k",
    })
    expect(unit).toBe(`[Unit]
Description=HinaCode cloud

[Service]
ExecStart="/home/k \\"dev\\"/50%% $$HOME/hinacode" "serve"
Environment="PATH=/home/k/.local/bin:/usr/bin"
Environment="HINACODE_USER_DATA=/home/k/100%%"
Restart=on-failure

[Install]
WantedBy=default.target
`)
  })
})

describe("serveCommand", () => {
  const running = { sea: false, execPath: "/usr/bin/node", executable: () => true }

  it.effect("runs the npm bin script it was started from, so an update in place keeps the service working", () =>
    Effect.gen(function* () {
      expect(yield* serveCommand({ ...running, script: "/opt/homebrew/bin/hinacode" })).toStrictEqual([
        "/opt/homebrew/bin/hinacode",
        "serve",
      ])
    }),
  )

  it.effect("runs the executable itself when it is one", () =>
    Effect.gen(function* () {
      expect(
        yield* serveCommand({ ...running, sea: true, execPath: "/home/k/hinacode/hinacode", script: "serve" }),
      ).toStrictEqual(["/home/k/hinacode/hinacode", "serve"])
    }),
  )

  it.effect("refuses an npx cache path and a script that cannot run on its own", () =>
    Effect.gen(function* () {
      const npx = yield* Effect.exit(
        serveCommand({ ...running, script: "/home/k/.npm/_npx/1a2b/node_modules/.bin/hinacode" }),
      )
      const checkout = yield* Effect.exit(
        serveCommand({ ...running, script: "/src/hinacode/out/server/cli.js", executable: () => false }),
      )
      expect(Exit.isFailure(npx) && JSON.stringify(npx.cause)).toMatch(/npm install -g/)
      expect(Exit.isFailure(checkout) && JSON.stringify(checkout.cause)).toMatch(/cannot run on its own/)
    }),
  )
})
