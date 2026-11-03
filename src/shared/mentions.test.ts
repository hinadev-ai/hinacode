import { describe, expect, test } from "@effect/vitest"
import { completionAt, suggestionsFor } from "./composerSyntax.ts"
import type { Project, Thread } from "./domain.ts"
import { MENTION, mentionableThreads, parseMention, terminalMention, threadMention } from "./mentions.ts"

const thread = (id: string, patch: Partial<Thread>): Thread => ({
  id,
  projectId: "desktop-hinacode",
  worktreeId: null,
  title: id,
  provider: "claude",
  model: "m",
  effort: null,
  fastMode: false,
  userSkills: true,
  accessMode: "auto",
  accountId: null,
  providerSessionId: null,
  forkedFrom: null,
  sideOf: null,
  parentId: null,
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  snoozedUntil: null,
  queue: [],
  scheduled: [],
  createdBy: "user",
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  ...patch,
})

const projects: ReadonlyArray<Pick<Project, "id" | "environmentId" | "repository">> = [
  { id: "desktop-hinacode", repository: "hinadev-ai/hinacode" },
  { id: "desktop-site", repository: "hinadev-ai/site" },
  { id: "desktop-clone", repository: "hinadev-ai/hinacode" },
  { id: "cloud-hinacode", environmentId: "cloud", repository: "hinadev-ai/hinacode" },
  { id: "cloud-site", environmentId: "cloud", repository: "hinadev-ai/site" },
]

const threads = [
  thread("composing", {}),
  thread("cloud-login", { projectId: "cloud-hinacode", title: "Login on the cloud" }),
  thread("desktop-login", { projectId: "desktop-hinacode", title: "Fix login", sortIndex: 1 }),
  thread("desktop-docs", { projectId: "desktop-hinacode", title: "Docs" }),
  thread("archived", { projectId: "cloud-hinacode", status: "archived" }),
  thread("other-repository", { projectId: "cloud-site" }),
  thread("second-clone", { projectId: "desktop-clone" }),
]

const ids = (list: ReadonlyArray<Thread>) => list.map((each) => each.id)

describe("mentionableThreads", () => {
  test("offers threads of the same repository on every machine, the composing thread's machine first", () => {
    const mentionable = mentionableThreads(threads[0]!, threads, projects)
    expect(ids(mentionable.sameMachine)).toStrictEqual(["desktop-docs", "desktop-login"])
    expect(ids(mentionable.otherMachines)).toStrictEqual(["cloud-login"])
  })

  test("leaves out another clone of the repository on the same machine, which read_thread refuses", () => {
    const mentionable = mentionableThreads(threads[0]!, threads, projects)
    expect(ids([...mentionable.sameMachine, ...mentionable.otherMachines])).not.toContain("second-clone")
  })

  test("treats the composing thread's machine as the same machine when it runs on a cloud", () => {
    const mentionable = mentionableThreads(threads[1]!, threads, projects)
    expect(ids(mentionable.sameMachine)).toStrictEqual([])
    expect(ids(mentionable.otherMachines)).toStrictEqual(["composing", "desktop-docs", "second-clone", "desktop-login"])
  })

  test("offers only its own project's threads before projects load", () => {
    const mentionable = mentionableThreads(threads[0]!, threads, [])
    expect(ids(mentionable.sameMachine)).toStrictEqual(["desktop-docs", "desktop-login"])
    expect(ids(mentionable.otherMachines)).toStrictEqual([])
  })
})

test("suggests same-machine threads before other machines' threads, even when a remote title matches better", () => {
  const suggestions = suggestionsFor(
    completionAt("@login", 6)!,
    [],
    [],
    mentionableThreads(threads[0]!, threads, projects),
    [],
  )
  expect(suggestions.map((suggestion) => suggestion.insert)).toStrictEqual([
    "@thread:desktop-login",
    "@thread:cloud-login",
  ])
})

describe("parseMention", () => {
  test("reads the kind and id of a whole thread or terminal token", () => {
    expect(parseMention(threadMention("t-1"))).toStrictEqual({ kind: "thread", id: "t-1" })
    const terminalId = "0f6c2b4e-9a51-4c7e-8d3f-2b1a0e9c7d55"
    expect(parseMention(terminalMention(terminalId))).toStrictEqual({ kind: "terminal", id: terminalId })
    expect(parseMention("@src/main.ts")).toBeNull()
    expect(parseMention("@terminal:t-1.")).toBeNull()
  })

  test("MENTION finds both kinds in running text", () => {
    const text = "compare @thread:t-1 with @terminal:abc-2."
    expect([...text.matchAll(MENTION)].map((match) => match[0])).toStrictEqual(["@thread:t-1", "@terminal:abc-2"])
  })
})
