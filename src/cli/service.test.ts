import { describe, expect, it } from "vitest"
import { launchAgentPlist, serveProgram, serviceManager, systemdUnit } from "./service.ts"

const service = {
  program: ["/opt/hinacode 1.0/hinacode", "serve"],
  env: { PATH: "/usr/bin:/bin", HINACODE_USER_DATA: "/data/50% & <more>" },
  log: "/home/me/.local/state/hinacode/serve.log",
}

describe("serveProgram", () => {
  it("runs the executable itself when it is a single executable", () => {
    expect(serveProgram({ execPath: "/x/hinacode", argv: ["/x/hinacode", "/x/hinacode", "connect"] }, true)).toEqual([
      "/x/hinacode",
      "serve",
    ])
  })

  it("runs node with the installed script", () => {
    const argv = ["/usr/bin/node", "/usr/lib/node_modules/hinacode/bin/hinacode.mjs", "connect"]
    expect(serveProgram({ execPath: "/usr/bin/node", argv }, false)).toEqual([
      "/usr/bin/node",
      "/usr/lib/node_modules/hinacode/bin/hinacode.mjs",
      "serve",
    ])
  })

  it("refuses npx's cache, which npm may clear", () => {
    const argv = ["/usr/bin/node", "/home/me/.npm/_npx/1a2b/node_modules/.bin/hinacode", "connect"]
    expect(() => serveProgram({ execPath: "/usr/bin/node", argv }, false)).toThrow(/install\.sh/)
  })
})

describe("systemdUnit", () => {
  it("quotes arguments and escapes systemd specifiers", () => {
    const unit = systemdUnit({ ...service, program: ['/opt/a "b"/hinacode', "$HOME", "100%"] })
    expect(unit).toContain(String.raw`ExecStart="/opt/a \"b\"/hinacode" "$$HOME" "100%%"`)
    expect(unit).toContain(`Environment="HINACODE_USER_DATA=/data/50%% & <more>"`)
    expect(unit).toContain("StandardOutput=append:/home/me/.local/state/hinacode/serve.log")
    expect(unit).toContain("Restart=always")
    expect(unit).toContain("WantedBy=default.target")
  })
})

describe("launchAgentPlist", () => {
  it("escapes XML in every value", () => {
    const plist = launchAgentPlist(service)
    expect(plist).toContain("<string>/opt/hinacode 1.0/hinacode</string>")
    expect(plist).toContain("<key>HINACODE_USER_DATA</key><string>/data/50% &#38; &#60;more&#62;</string>")
    expect(plist).toContain("<key>KeepAlive</key><true/>")
    expect(plist).not.toMatch(/&(?!#\d+;)/)
  })
})

describe("serviceManager", () => {
  it("installs a launchd agent for the user's GUI session on macOS", () => {
    const manager = serviceManager({ platform: "darwin", home: "/Users/me", uid: 501, env: {} })
    expect(manager.unitPath).toBe("/Users/me/Library/LaunchAgents/ai.hinacode.serve.plist")
    expect(manager.log).toBe("/Users/me/Library/Logs/hinacode/serve.log")
    expect(manager.start).toEqual([
      { file: "launchctl", args: ["bootstrap", "gui/501", "/Users/me/Library/LaunchAgents/ai.hinacode.serve.plist"] },
    ])
  })

  it("follows the XDG directories on Linux", () => {
    const manager = serviceManager({
      platform: "linux",
      home: "/home/me",
      uid: 1000,
      env: { XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/state" },
    })
    expect(manager.unitPath).toBe("/cfg/systemd/user/hinacode.service")
    expect(manager.log).toBe("/state/hinacode/serve.log")
  })

  it("refuses a platform without a supported service manager", () => {
    expect(() => serviceManager({ platform: "win32", home: "C:\\Users\\me", uid: -1, env: {} })).toThrow(/serve/)
  })
})
