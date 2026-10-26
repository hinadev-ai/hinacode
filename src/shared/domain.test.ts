import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { RpcMethods } from "./contract.ts"
import { defaultSettings, PullRequest, Settings, Thread } from "./domain.ts"

const legacySettings = Object.fromEntries(
  Object.entries(defaultSettings).filter(([key]) => key !== "defaultAccountName"),
)

const legacyThread: Omit<Thread, "userSkills"> = {
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
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  snoozedUntil: null,
  queue: [],
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
    })
  })

  it("keeps user skills enabled for threads from before conversation mode", () => {
    expect(Schema.decodeUnknownSync(Thread)(legacyThread).userSkills).toBe(true)
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
    expect(Schema.decodeUnknownSync(Thread)({ ...legacyThread, userSkills: false }).userSkills).toBe(false)
    expect(
      Schema.decodeUnknownSync(Settings)({
        ...legacySettings,
        defaultAccountName: { claude: "Work", codex: null, muse: null },
      }).defaultAccountName.claude,
    ).toBe("Work")
    expect(() => Schema.decodeUnknownSync(Thread)({ ...legacyThread, userSkills: "false" })).toThrow()
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
