import { expect, test } from "@effect/vitest"
import type { Thread } from "../../shared/domain.ts"
import {
  selectInboxThreads,
  selectPinnedThreads,
  selectSnoozedThreads,
  selectUnpinnedProjectThreads,
} from "./threads.ts"

const thread = (id: string, patch: Partial<Thread>): Thread => ({
  id,
  projectId: "p1",
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

const state = {
  byId: Object.fromEntries(
    [
      thread("old", { updatedAt: "2026-10-14T01:00:00.000Z", sortIndex: 0 }),
      thread("new", { projectId: "p2", updatedAt: "2026-10-14T03:00:00.000Z" }),
      thread("archived", { status: "archived", updatedAt: "2026-10-14T04:00:00.000Z" }),
      thread("pinnedLater", { pinnedAt: "2026-10-14T06:00:00.000Z", updatedAt: "2026-10-14T05:00:00.000Z" }),
      thread("pinnedFirst", { pinnedAt: "2026-10-14T02:00:00.000Z", sortIndex: 1 }),
      thread("archivedPinned", { status: "archived", pinnedAt: "2026-10-14T01:00:00.000Z" }),
      thread("wakesLater", { snoozedUntil: "2026-10-16T09:00:00.000Z" }),
      thread("wakesSoon", { snoozedUntil: "2026-10-15T09:00:00.000Z" }),
      thread("woke", { snoozedUntil: "2026-10-14T03:30:00.000Z", updatedAt: "2026-10-14T00:30:00.000Z" }),
      thread("pinnedSnoozed", { pinnedAt: "2026-10-14T07:00:00.000Z", snoozedUntil: "2026-10-16T09:00:00.000Z" }),
    ].map((item) => [item.id, item]),
  ),
}
const ids = (threads: ReadonlyArray<Thread>) => threads.map((item) => item.id)

const now = Date.parse("2026-10-14T12:00:00.000Z")

test("the inbox lists active threads of every project that are neither pinned nor snoozed, latest first", () => {
  expect(ids(selectInboxThreads(now)(state))).toStrictEqual(["woke", "new", "old"])
})

test("snoozed threads are listed apart, the first to wake on top", () => {
  expect(ids(selectSnoozedThreads(now)(state))).toStrictEqual(["wakesSoon", "wakesLater"])
})

test("a snoozed thread returns to the inbox when it wakes", () => {
  const later = Date.parse("2026-10-15T09:00:00.000Z")
  expect(ids(selectInboxThreads(later)(state))).toStrictEqual(["wakesSoon", "woke", "new", "old"])
})

test("pinned threads are listed in the order they were pinned, without archived ones", () => {
  expect(ids(selectPinnedThreads(state))).toStrictEqual(["pinnedFirst", "pinnedLater", "pinnedSnoozed"])
})

test("a project's unpinned threads leave out the pinned ones", () => {
  expect(ids(selectUnpinnedProjectThreads("p1")(state))).toStrictEqual(["old", "wakesLater", "wakesSoon", "woke"])
})
