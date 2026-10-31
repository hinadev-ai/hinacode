import { describe, expect, test } from "@effect/vitest"
import { completionAt, suggestionsFor } from "./composerSyntax.ts"
import type { Project, Thread } from "./domain.ts"
import { mentionableThreads } from "./threadMention.ts"

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
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  snoozedUntil: null,
  queue: [],
  createdBy: "user",
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  ...patch,
})

const projects: ReadonlyArray<Pick<Project, "id" | "environmentId" | "repository">> = [
  { id: "desktop-hinacode", repository: "hinadev-ai/hinacode" },
  { id: "desktop-site", repository: "hinadev-ai/site" },
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
]

const ids = (list: ReadonlyArray<Thread>) => list.map((each) => each.id)

describe("mentionableThreads", () => {
  test("offers threads of the same repository on every machine, the composing thread's machine first", () => {
    const mentionable = mentionableThreads(threads[0]!, threads, projects)
    expect(ids(mentionable.sameMachine)).toStrictEqual(["desktop-docs", "desktop-login"])
    expect(ids(mentionable.otherMachines)).toStrictEqual(["cloud-login"])
  })

  test("treats the composing thread's machine as the same machine when it runs on a cloud", () => {
    const mentionable = mentionableThreads(threads[1]!, threads, projects)
    expect(ids(mentionable.sameMachine)).toStrictEqual([])
    expect(ids(mentionable.otherMachines)).toStrictEqual(["composing", "desktop-docs", "desktop-login"])
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
