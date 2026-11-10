import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { RpcMethods } from "./contract.ts"
import {
  chatFolder,
  defaultSettings,
  enabledProviders,
  isCronExpression,
  PullRequest,
  Settings,
  startingProvider,
  Thread,
  workspaceStatus,
} from "./domain.ts"

const legacySettings = Object.fromEntries(
  Object.entries(defaultSettings).filter(([key]) => key !== "defaultAccountName"),
)

const withoutOpencode = (value: unknown) => {
  if (typeof value !== "object" || value === null || !("claude" in value)) return value
  const { opencode: _opencode, ...rest } = value as Record<string, unknown>
  return rest
}

const legacyThread: Thread = {
  id: "older-cloud-thread",
  projectId: "project",
  worktreeId: null,
  title: "Existing thread",
  provider: "claude",
  model: "claude-sonnet-5-5",
  effort: null,
  fastMode: false,
  accessMode: "supervised",
  accountId: null,
  providerSessionId: null,
  forkedFrom: null,
  sideOf: null,
  parentId: null,
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  settledAt: null,
  snoozedUntil: null,
  queue: [],
  scheduled: [],
  createdBy: "user",
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
}

describe("older cloud responses", () => {
  it("uses translated default account names when an older cloud omits the names", () => {
    expect(Schema.decodeUnknownSync(Settings)(legacySettings).defaultAccountName).toStrictEqual({
      claude: null,
      codex: null,
      muse: null,
      opencode: null,
      magpie: null,
    })
  })

  it("gives opencode empty defaults in settings saved before it existed", () => {
    const beforeOpencode = Object.fromEntries(
      Object.entries(defaultSettings).map(([key, value]) => [key, withoutOpencode(value)]),
    )
    const settings = Schema.decodeUnknownSync(Settings)(beforeOpencode)
    expect(settings.defaultModel.opencode).toBeNull()
    expect(settings.modelPresets.opencode).toStrictEqual([])
    expect(settings.defaultFastMode.opencode).toBe(false)
  })

  it("has no global actions when settings predate them", () => {
    const { actions: _actions, ...withoutActions } = defaultSettings
    expect(Schema.decodeUnknownSync(Settings)(withoutActions).actions).toStrictEqual([])
  })

  it("reads mergeability as unknown from a pull request summary that omits it", () => {
    const legacyPullRequest: Omit<PullRequest, "mergeable"> = {
      url: "https://github.com/a/b/pull/1",
      number: 1,
      title: "Fix",
      status: "open",
      checks: null,
      review: null,
      author: "octocat",
      headRefName: "fix",
      baseRefName: "main",
      additions: 1,
      deletions: 0,
    }
    expect(Schema.decodeUnknownSync(PullRequest)(legacyPullRequest).mergeable).toBe("unknown")
  })

  it("preserves explicit settings and rejects malformed values", () => {
    expect(
      Schema.decodeUnknownSync(Settings)({
        ...legacySettings,
        defaultAccountName: { claude: "Work", codex: null, muse: null },
      }).defaultAccountName.claude,
    ).toBe("Work")
    expect(() =>
      Schema.decodeUnknownSync(Settings)({
        ...legacySettings,
        defaultAccountName: { claude: 42, codex: null, muse: null },
      }),
    ).toThrow()
  })

  it("leaves unrelated mutation patches unchanged", () => {
    const settingsPatch = { textGenerationModel: "claude-sonnet-5-5" }
    expect(Schema.decodeUnknownSync(RpcMethods["settings.set"].request)(settingsPatch)).toStrictEqual(settingsPatch)
    const threadPatch = { id: legacyThread.id, title: "Renamed" }
    expect(Schema.decodeUnknownSync(RpcMethods["threads.update"].request)(threadPatch)).toStrictEqual(threadPatch)
  })
})

describe("chatFolder", () => {
  it("joins with the separator of the machine the chats root is on", () => {
    expect(chatFolder("/home/k/.config/kkcode/chats", "t1")).toBe("/home/k/.config/kkcode/chats/t1")
    expect(chatFolder("C:\\Users\\k\\AppData\\Roaming\\kkcode\\chats\\", "t1")).toBe(
      "C:\\Users\\k\\AppData\\Roaming\\kkcode\\chats\\t1",
    )
  })
})

describe("workspaceStatus", () => {
  it("is missing when a ready worktree's folder is gone", () => {
    expect(workspaceStatus("ready", "missing")).toBe("missing")
  })

  it("keeps the worktree status while the folder is there or unknown", () => {
    expect(workspaceStatus("ready", "clean")).toBe("ready")
    expect(workspaceStatus("ready", null)).toBe("ready")
    expect(workspaceStatus("removed", "missing")).toBe("removed")
  })
})

describe("listener settings", () => {
  const setSettings = Schema.decodeUnknownSync(RpcMethods["settings.set"].request)

  it("accept a change to one field of a settings group", () => {
    expect(setSettings({ experimental: { devices: true } })).toStrictEqual({ experimental: { devices: true } })
  })

  it("refuse an address that binds every interface", () => {
    for (const bindHost of ["0.0.0.0", "::"]) {
      expect(() => setSettings({ remote: { enabled: true, bindHost, port: 48081 } })).toThrow()
      expect(() => setSettings({ routines: { bindHost, port: 48080 } })).toThrow()
    }
  })

  it("always name where remote control listens", () => {
    expect(() => setSettings({ remote: { enabled: false, bindHost: null, port: 48081 } })).toThrow()
    expect(setSettings({ remote: { enabled: true, bindHost: "100.64.0.2", port: 48081 } }).remote?.bindHost).toBe(
      "100.64.0.2",
    )
  })
})

describe("enabledProviders", () => {
  const installed = { claude: false, codex: true, muse: false, opencode: true, magpie: false }

  it("leaves out an agent whose CLI is missing, whatever its switch says", () => {
    expect(enabledProviders(defaultSettings, installed)).toStrictEqual(["codex", "opencode"])
  })

  it("keeps every switched-on agent while the machine has not answered yet", () => {
    expect(enabledProviders(defaultSettings)).toStrictEqual(["claude", "codex", "muse", "opencode", "magpie"])
  })

  it("starts new threads on the first installed agent when the default one is missing", () => {
    expect(startingProvider(defaultSettings, installed)).toBe("codex")
  })
})

describe("isCronExpression", () => {
  it("accepts a schedule that runs and rejects one that never does", () => {
    expect(isCronExpression("0 9 * * 1-5", "Asia/Tokyo")).toBe(true)
    expect(isCronExpression("0 9 30 2 *", "UTC")).toBe(false)
    expect(isCronExpression("0 9 * * *", "Not/AZone")).toBe(false)
    expect(isCronExpression("nope", "UTC")).toBe(false)
  })
})
