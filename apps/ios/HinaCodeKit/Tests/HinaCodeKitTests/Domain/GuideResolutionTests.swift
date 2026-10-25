import HinaCodeKit
import Testing

private func file(
    _ path: String, patch: String = "@@ -10,3 +10,4 @@\n a\n-b\n+c\n+d\n e", previousPath: String? = nil
) -> PullRequestFile {
    PullRequestFile(
        path: path, previousPath: previousPath, status: .modified, additions: 2, deletions: 1, binary: false,
        patch: patch)
}

private func group(
    _ key: String, _ filePaths: [String], critical: Bool? = nil, fileNotes: [GuideFileNote]? = nil,
    lineNotes: [GuideLineNote]? = nil, children: [GuideGroup.Children]? = nil
) -> GuideGroup {
    GuideGroup(
        key: key, label: key, category: .core, critical: critical, filePaths: filePaths, fileNotes: fileNotes,
        lineNotes: lineNotes, children: children)
}

private func child(_ key: String, _ filePaths: [String], critical: Bool? = nil) -> GuideGroup.Children {
    GuideGroup.Children(key: key, label: key, category: .core, critical: critical, filePaths: filePaths)
}

private func guide(_ groups: [GuideGroup]) -> PullRequestGuide {
    PullRequestGuide(
        head: "h1", model: "claude-sonnet-5-5", generatedAt: "2026-10-23T00:00:00.000Z", summary: "", groups: groups)
}

private func paths(_ files: [GuideResolution.File]) -> [String] { files.map(\.file.path) }

struct GuideResolutionTests {
    @Test func `files keep the guide's order, and files no group names come last`() {
        let resolution = GuideResolution(
            guide: guide([group("b", ["b.ts"]), group("a", ["a.ts"])]),
            files: [file("a.ts"), file("b.ts"), file("c.ts")])
        #expect(resolution.groups.map(\.key) == ["b", "a"])
        #expect(resolution.groups.map { paths($0.files) } == [["b.ts"], ["a.ts"]])
        #expect(paths(resolution.others) == ["c.ts"])
    }

    @Test func `a file that left the pull request is dropped, and so is a group left with nothing`() {
        let resolution = GuideResolution(
            guide: guide([group("gone", ["gone.ts"]), group("kept", ["kept.ts", "gone.ts"])]), files: [file("kept.ts")])
        #expect(resolution.groups.map(\.key) == ["kept"])
        #expect(resolution.groups.map { paths($0.files) } == [["kept.ts"]])
    }

    @Test func `a file named twice stays in its first group`() {
        let resolution = GuideResolution(
            guide: guide([group("first", ["a.ts"]), group("second", ["a.ts", "b.ts"])]),
            files: [file("a.ts"), file("b.ts")])
        #expect(resolution.groups.map { paths($0.files) } == [["a.ts"], ["b.ts"]])
    }

    @Test func `a file renamed after the guide was written is found by its old path`() {
        let resolution = GuideResolution(
            guide: guide([group("a", ["old.ts"])]), files: [file("new.ts", previousPath: "old.ts")])
        #expect(paths(resolution.groups.first?.files ?? []) == ["new.ts"])
        #expect(resolution.others.isEmpty)
    }

    @Test func `line notes outside every hunk move next to the file notes, since the diff cannot show them`() {
        let shown = GuideLineNote(path: "a.ts", text: "shown", side: .additions, line: 12)
        let removed = GuideLineNote(path: "a.ts", text: "removed line", side: .deletions, line: 11)
        let elsewhere = GuideLineNote(path: "a.ts", text: "not in a hunk", side: .additions, line: 40)
        let resolution = GuideResolution(
            guide: guide([
                group(
                    "a", ["a.ts"], fileNotes: [GuideFileNote(path: "a.ts", text: "f")],
                    lineNotes: [shown, removed, elsewhere])
            ]),
            files: [file("a.ts")])
        let resolved = resolution.groups.first?.files.first
        #expect(resolved?.fileNotes.map(\.text) == ["f"])
        #expect(resolved?.lineNotesInHunks.map(\.text) == ["shown", "removed line"])
        #expect(resolved?.lineNotesOutsideHunks.map(\.text) == ["not in a hunk"])
    }

    @Test func `a note on a file of another group is dropped`() {
        let resolution = GuideResolution(
            guide: guide([
                group("a", ["a.ts"], fileNotes: [GuideFileNote(path: "b.ts", text: "wrong group")]),
                group("b", ["b.ts"]),
            ]),
            files: [file("a.ts"), file("b.ts")])
        #expect(resolution.groups.flatMap { $0.files.flatMap(\.fileNotes) }.isEmpty)
    }

    @Test func `groups get unique keys even when the model repeats one`() {
        let resolution = GuideResolution(
            guide: guide([group("ui", ["a.ts"]), group("ui", ["b.ts"], children: [child("ui", ["c.ts"])])]),
            files: [file("a.ts"), file("b.ts"), file("c.ts")])
        let keys = [
            resolution.groups.first?.key, resolution.groups.dropFirst().first?.key,
            resolution.groups.dropFirst().first?.children.first?.key,
        ]
        #expect(keys == ["ui", "ui-2", "ui-3"])
    }

    @Test func `a group is critical when it, one of its notes or one of its children is`() {
        let resolution = GuideResolution(
            guide: guide([
                group("flag", ["a.ts"], critical: true),
                group(
                    "note", ["b.ts"],
                    lineNotes: [GuideLineNote(path: "b.ts", text: "x", critical: true, side: .additions, line: 11)]),
                group("parent", [], children: [child("child", ["c.ts"], critical: true)]),
                group("calm", ["d.ts"]),
            ]),
            files: [file("a.ts"), file("b.ts"), file("c.ts"), file("d.ts")])
        #expect(resolution.groups.map(\.key) == ["flag", "note", "parent", "calm"])
        #expect(resolution.groups.map(\.containsCritical) == [true, true, true, false])
    }
}
