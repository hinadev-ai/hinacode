import { expect, it } from "vitest"
import type { LinearIssue } from "./domain.ts"
import { sortIssues } from "./linear.ts"

const issue = (id: string, type: string, priority: number, updatedAt: string) =>
  ({ id, identifier: id, title: id, url: "", state: { name: type, type }, priority, updatedAt }) as LinearIssue

it("lists each issue once, work in progress first, then by priority with no priority last", () => {
  const sorted = sortIssues([
    issue("backlog", "backlog", 1, "2026-10-24"),
    issue("todo-none", "unstarted", 0, "2026-10-24"),
    issue("todo-low", "unstarted", 4, "2026-10-20"),
    issue("doing", "started", 3, "2026-10-01"),
    issue("todo-low", "unstarted", 4, "2026-10-20"),
  ])
  expect(sorted.map((entry) => entry.id)).toStrictEqual(["doing", "todo-low", "todo-none", "backlog"])
})
