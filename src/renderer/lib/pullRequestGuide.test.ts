import { describe, expect, test } from "@effect/vitest"
import type { GuideGroup, PullRequestFile, PullRequestGuide } from "../../shared/domain.ts"
import { noteAnnotations, resolveGuide } from "./pullRequestGuide.ts"

const file = (path: string, patch = "@@ -10,3 +10,4 @@\n a\n-b\n+c\n+d\n e", previousPath: string | null = null) =>
  ({ path, previousPath, status: "modified", additions: 2, deletions: 1, binary: false, patch }) as PullRequestFile

const group = (key: string, filePaths: ReadonlyArray<string>, extra: Partial<GuideGroup> = {}): GuideGroup => ({
  key,
  label: key,
  category: "core",
  filePaths,
  ...extra,
})

const guide = (groups: ReadonlyArray<GuideGroup>): PullRequestGuide => ({
  head: "h1",
  model: "claude-sonnet-5-5",
  generatedAt: "2026-10-23T00:00:00.000Z",
  summary: "",
  groups,
})

const paths = (files: ReadonlyArray<{ readonly file: PullRequestFile }>) => files.map((entry) => entry.file.path)

describe("resolveGuide", () => {
  test("files keep the guide's order, and files no group names come last", () => {
    const { groups, others } = resolveGuide(guide([group("b", ["b.ts"]), group("a", ["a.ts"])]), [
      file("a.ts"),
      file("b.ts"),
      file("c.ts"),
    ])
    expect(groups.map((resolved) => [resolved.key, paths(resolved.files)])).toStrictEqual([
      ["b", ["b.ts"]],
      ["a", ["a.ts"]],
    ])
    expect(paths(others)).toStrictEqual(["c.ts"])
  })

  test("a file that left the pull request is dropped, and so is a group left with nothing", () => {
    const { groups } = resolveGuide(guide([group("gone", ["gone.ts"]), group("kept", ["kept.ts", "gone.ts"])]), [
      file("kept.ts"),
    ])
    expect(groups.map((resolved) => [resolved.key, paths(resolved.files)])).toStrictEqual([["kept", ["kept.ts"]]])
  })

  test("a file named twice stays in its first group", () => {
    const { groups } = resolveGuide(guide([group("first", ["a.ts"]), group("second", ["a.ts", "b.ts"])]), [
      file("a.ts"),
      file("b.ts"),
    ])
    expect(groups.map((resolved) => paths(resolved.files))).toStrictEqual([["a.ts"], ["b.ts"]])
  })

  test("a file renamed after the guide was written is found by its old path", () => {
    const { groups, others } = resolveGuide(guide([group("a", ["old.ts"])]), [file("new.ts", undefined, "old.ts")])
    expect(paths(groups[0]?.files ?? [])).toStrictEqual(["new.ts"])
    expect(others).toStrictEqual([])
  })

  test("line notes outside every hunk move next to the file notes, since the diff cannot show them", () => {
    const shown = { path: "a.ts", side: "additions", line: 12, text: "shown" } as const
    const removed = { path: "a.ts", side: "deletions", line: 11, text: "removed line" } as const
    const elsewhere = { path: "a.ts", side: "additions", line: 40, text: "not in a hunk" } as const
    const { groups } = resolveGuide(
      guide([
        group("a", ["a.ts"], { lineNotes: [shown, removed, elsewhere], fileNotes: [{ path: "a.ts", text: "f" }] }),
      ]),
      [file("a.ts")],
    )
    const [resolved] = groups[0]?.files ?? []
    expect(resolved?.fileNotes.map((note) => note.text)).toStrictEqual(["f"])
    expect(resolved?.lineNotes.map((note) => note.text)).toStrictEqual(["shown", "removed line"])
    expect(resolved?.strayLineNotes.map((note) => note.text)).toStrictEqual(["not in a hunk"])
  })

  test("a note on a file of another group is dropped", () => {
    const { groups } = resolveGuide(
      guide([group("a", ["a.ts"], { fileNotes: [{ path: "b.ts", text: "wrong group" }] }), group("b", ["b.ts"])]),
      [file("a.ts"), file("b.ts")],
    )
    expect(groups.flatMap((resolved) => resolved.files.flatMap((entry) => entry.fileNotes))).toStrictEqual([])
  })

  test("groups get unique keys even when the model repeats one", () => {
    const { groups } = resolveGuide(
      guide([group("ui", ["a.ts"]), group("ui", ["b.ts"], { children: [group("ui", ["c.ts"])] })]),
      [file("a.ts"), file("b.ts"), file("c.ts")],
    )
    expect([groups[0]?.key, groups[1]?.key, groups[1]?.children[0]?.key]).toStrictEqual(["ui", "ui-2", "ui-3"])
  })

  test("a group is critical when it, one of its notes or one of its children is", () => {
    const { groups } = resolveGuide(
      guide([
        group("flag", ["a.ts"], { critical: true }),
        group("note", ["b.ts"], {
          lineNotes: [{ path: "b.ts", side: "additions", line: 11, text: "x", critical: true }],
        }),
        group("parent", [], { children: [group("child", ["c.ts"], { critical: true })] }),
        group("calm", ["d.ts"]),
      ]),
      [file("a.ts"), file("b.ts"), file("c.ts"), file("d.ts")],
    )
    expect(groups.map((resolved) => [resolved.key, resolved.critical])).toStrictEqual([
      ["flag", true],
      ["note", true],
      ["parent", true],
      ["calm", false],
    ])
  })
})

describe("noteAnnotations", () => {
  test("notes on the same line share one annotation", () => {
    const first = { path: "a.ts", side: "additions", line: 3, text: "one" } as const
    const second = { path: "a.ts", side: "additions", line: 3, text: "two" } as const
    const removed = { path: "a.ts", side: "deletions", line: 3, text: "old" } as const
    expect(noteAnnotations([first, removed, second])).toStrictEqual([
      { side: "additions", lineNumber: 3, metadata: [first, second] },
      { side: "deletions", lineNumber: 3, metadata: [removed] },
    ])
  })
})
