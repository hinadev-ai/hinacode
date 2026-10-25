import HinaCodeKit
import Testing

@Suite struct FileKindTests {
    @Test("splits a path into its folder and name")
    func folderAndName() {
        #expect(FileKind.basename("src/app/index.ts") == "index.ts")
        #expect(FileKind.dirname("src/app/index.ts") == "src/app")
        #expect(FileKind.basename("README.md") == "README.md")
        #expect(FileKind.dirname("README.md") == "")
    }

    @Test("lowercases the last extension and ignores dots in folders")
    func lowercasedExtension() {
        #expect(FileKind.pathExtension("src/app.v2/Logo.PNG") == "png")
        #expect(FileKind.pathExtension("archive.tar.gz") == "gz")
        #expect(FileKind.pathExtension("src.d/Makefile") == "")
        #expect(FileKind.pathExtension(".gitignore") == "gitignore")
    }

    @Test("tells images, SVG and Markdown from text")
    func kinds() {
        #expect(FileKind(path: "a/b.jpeg") == .image)
        #expect(FileKind(path: "icon.AVIF") == .image)
        #expect(FileKind(path: "logo.svg") == .svg)
        #expect(FileKind(path: "docs/README.md") == .markdown)
        #expect(FileKind(path: "page.mdx") == .markdown)
        #expect(FileKind(path: "src/index.ts") == .text)
        #expect(FileKind(path: "LICENSE") == .text)
    }

    @Test("picks an icon by kind and extension")
    func icons() {
        #expect(FileKind.icon(path: "src", entry: .dir) == .folder)
        #expect(FileKind.icon(path: "src/index.tsx", entry: .file) == .code)
        #expect(FileKind.icon(path: "logo.svg", entry: .file) == .image)
        #expect(FileKind.icon(path: "README.md", entry: .symlink) == .markdown)
        #expect(FileKind.icon(path: "notes.txt", entry: .file) == .text)
        #expect(FileKind.icon(path: "LICENSE", entry: .file) == .text)
        #expect(FileKind.icon(path: "data.bin", entry: .file) == .file)
    }

    @Test("reads the viewBox first")
    func viewBoxFirst() {
        #expect(FileKind.svgAspectRatio(#"<?xml version="1.0"?><svg width="10" viewBox="0 0 200 100"></svg>"#) == 2)
        #expect(FileKind.svgAspectRatio("<svg viewBox='0,0,24,48'/>") == 0.5)
    }

    @Test("falls back to width and height")
    func widthAndHeight() {
        #expect(FileKind.svgAspectRatio(#"<svg width="300px" height="150"></svg>"#) == 2)
    }

    @Test("is null without a usable size")
    func noUsableSize() {
        #expect(FileKind.svgAspectRatio(#"<svg width="100%" height="100%"></svg>"#) == nil)
        #expect(FileKind.svgAspectRatio("not an svg") == nil)
    }
}
