import HinaCodeKit
import Testing

private let root = "/abs/root"

private func image(_ src: String, _ root: String?, folder: String = "") -> MarkdownPath.ImageSource {
    MarkdownPath.imageSource(src, root: root, folder: folder)
}

@Suite struct MarkdownImageSourceTests {
    @Test("loads URLs directly")
    func urls() {
        #expect(image("https://example.com/a.png", root) == .uri("https://example.com/a.png"))
        #expect(image("http://example.com/a.png", nil) == .uri("http://example.com/a.png"))
        #expect(image("data:image/png;base64,AAAA", nil) == .uri("data:image/png;base64,AAAA"))
    }

    @Test("resolves relative paths against the root")
    func relativePaths() {
        #expect(image("./.context/image-1.png", root) == .file(root: root, path: ".context/image-1.png"))
        #expect(image("docs/a.png", root) == .file(root: root, path: "docs/a.png"))
        #expect(image("docs/../shots/./b.png", root) == .file(root: root, path: "shots/b.png"))
        #expect(image("docs//c.png", root) == .file(root: root, path: "docs/c.png"))
    }

    @Test("decodes escapes and drops the query and hash")
    func escapesQueryAndHash() {
        #expect(image("./my%20shot.png?raw=1", root) == .file(root: root, path: "my shot.png"))
        #expect(image("a.png#zoom", root) == .file(root: root, path: "a.png"))
    }

    @Test("refuses paths that leave the root")
    func outsideRoot() {
        #expect(image("../escape.png", root) == .unavailable(.outsideRoot))
        #expect(image("a/../../escape.png", root) == .unavailable(.outsideRoot))
        #expect(image("/etc/passwd", root) == .unavailable(.outsideRoot))
        #expect(image("/abs/rootish/a.png", root) == .unavailable(.outsideRoot))
        #expect(image("/abs/root/../other/a.png", root) == .unavailable(.outsideRoot))
    }

    @Test("makes absolute paths inside the root relative")
    func absoluteInsideRoot() {
        #expect(image("/abs/root/a.png", root) == .file(root: root, path: "a.png"))
        #expect(image("/abs/root/a.png", "/abs/root/") == .file(root: "/abs/root/", path: "a.png"))
        #expect(image("file:///abs/root/img/b.png", root) == .file(root: root, path: "img/b.png"))
    }

    @Test("needs a root for a path")
    func needsRoot() {
        #expect(image("./a.png", nil) == .unavailable(.noRoot))
    }

    @Test("rejects what is not a file")
    func notAFile() {
        #expect(image("", root) == .unavailable(.invalid))
        #expect(image("ftp://example.com/a.png", root) == .unavailable(.invalid))
        #expect(image("./%E0%A4%A.png", root) == .unavailable(.invalid))
        #expect(image("/abs/root", root) == .unavailable(.invalid))
        #expect(image(".", root) == .unavailable(.invalid))
    }
}

@Suite struct MarkdownFilePathTests {
    @Test("start from the file's folder")
    func fromFolder() {
        #expect(image("./shot.png", root, folder: "docs/guide") == .file(root: root, path: "docs/guide/shot.png"))
        #expect(MarkdownPath.fileLink("../README.md", root: root, folder: "docs") == "README.md")
        #expect(MarkdownPath.fileLink("/abs/root/src/a.ts", root: root, folder: "docs") == "src/a.ts")
    }

    @Test("treat a link to an anchor as no file")
    func anchors() {
        #expect(MarkdownPath.fileLink("#setup", root: root, folder: "docs") == nil)
        #expect(MarkdownPath.fileLink("?tab=1", root: root, folder: "docs") == nil)
    }

    @Test("still cannot climb out of the root")
    func cannotClimbOut() {
        #expect(MarkdownPath.fileLink("../../x.md", root: root, folder: "docs") == nil)
    }
}

@Suite struct MarkdownFileLinkTests {
    @Test("resolves a relative link to a path in the root")
    func relativeLink() {
        #expect(MarkdownPath.fileLink("./README.md", root: root) == "README.md")
        #expect(MarkdownPath.fileLink("src/a%20b.ts#L10", root: root) == "src/a b.ts")
    }

    @Test("returns null for anything that is not a file in the root")
    func notAFileInRoot() {
        #expect(MarkdownPath.fileLink("./README.md", root: nil) == nil)
        #expect(MarkdownPath.fileLink("../outside.md", root: root) == nil)
        #expect(MarkdownPath.fileLink("#section", root: root) == nil)
        #expect(MarkdownPath.fileLink("mailto:me@example.com", root: root) == nil)
    }
}
