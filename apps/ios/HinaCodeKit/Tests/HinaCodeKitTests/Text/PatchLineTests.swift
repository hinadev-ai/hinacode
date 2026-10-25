import HinaCodeKit
import Testing

private let patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,3 @@ export function a() {",
    " keep",
    "-old",
    "+new",
    " keep",
    "@@ -40,2 +40,3 @@",
    " tail",
    "+added",
    " end",
    "\\ No newline at end of file",
].joined(separator: "\n")

@Suite struct PatchLineTests {
    @Test("drops the file headers and numbers each side across hunks")
    func numbersAcrossHunks() {
        #expect(
            PatchLine.lines(of: patch) == [
                PatchLine(kind: .hunk, text: "@@ -10,3 +10,3 @@ export function a() {", oldLine: nil, newLine: nil),
                PatchLine(kind: .context, text: "keep", oldLine: 10, newLine: 10),
                PatchLine(kind: .deletion, text: "old", oldLine: 11, newLine: nil),
                PatchLine(kind: .addition, text: "new", oldLine: nil, newLine: 11),
                PatchLine(kind: .context, text: "keep", oldLine: 12, newLine: 12),
                PatchLine(kind: .hunk, text: "@@ -40,2 +40,3 @@", oldLine: nil, newLine: nil),
                PatchLine(kind: .context, text: "tail", oldLine: 40, newLine: 40),
                PatchLine(kind: .addition, text: "added", oldLine: nil, newLine: 41),
                PatchLine(kind: .context, text: "end", oldLine: 41, newLine: 42),
                PatchLine(kind: .note, text: "\\ No newline at end of file", oldLine: nil, newLine: nil),
            ])
    }

    @Test("has no lines for a patch without hunks, like a binary file or a pure rename")
    func noHunks() {
        #expect(PatchLine.lines(of: "diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ").isEmpty)
    }
}
