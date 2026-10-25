import Foundation

/// How the file viewer shows a file, and the path helpers the file browser names entries with
/// (`apps/mobile/src/lib/file-kinds.ts`). Paths are workspace-relative and `/`-separated.
public enum FileKind: Hashable, Sendable {
    case image, svg, markdown, text

    /// The listing's icon for an entry. The view picks the symbol.
    public enum Icon: Hashable, Sendable {
        case folder, code, image, markdown, text, file
    }

    private static let images: Set = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]
    private static let markdownExtensions: Set = ["md", "mdx", "markdown"]
    private static let code = Set(
        ("ts tsx mts cts js jsx mjs cjs json jsonc py rb go rs java kt kts swift c h cc cpp hpp cs m mm php sh bash zsh "
            + "fish css scss sass less html htm xml vue svelte astro sql yaml yml toml lua zig ex exs erl hs ml dart "
            + "scala r pl tf nix graphql gql proto tla cfg ini")
            .split(separator: " ").map(String.init))
    private static let textExtensions: Set = [
        "txt", "log", "csv", "tsv", "rst", "adoc", "org", "env", "lock", "gitignore", "gitattributes",
    ]
    private static let textNames: Set = [
        "license", "licence", "readme", "changelog", "authors", "notice", "copying", "makefile",
    ]

    public init(path: String) {
        let ext = Self.pathExtension(path)
        if Self.images.contains(ext) {
            self = .image
        } else if ext == "svg" {
            self = .svg
        } else if Self.markdownExtensions.contains(ext) {
            self = .markdown
        } else {
            self = .text
        }
    }

    /// Symlinks get the file icons, since they are never followed.
    public static func icon(path: String, entry: FsEntryKind) -> Icon {
        if entry == .dir { return .folder }
        let ext = pathExtension(path)
        if images.contains(ext) || ext == "svg" { return .image }
        if markdownExtensions.contains(ext) { return .markdown }
        if code.contains(ext) { return .code }
        if textExtensions.contains(ext) || textNames.contains(basename(path).lowercased()) { return .text }
        return .file
    }

    /// The last segment of a path.
    public static func basename(_ path: String) -> String {
        path.lastIndex(of: "/").map { String(path[path.index(after: $0)...]) } ?? path
    }

    /// The folder part of a path, "" at the top level.
    public static func dirname(_ path: String) -> String {
        path.lastIndex(of: "/").map { String(path[..<$0]) } ?? ""
    }

    /// The lowercased extension without its dot, or "" when there is none. A dotfile's name is its extension.
    public static func pathExtension(_ path: String) -> String {
        let name = basename(path)
        return name.lastIndex(of: ".").map { name[name.index(after: $0)...].lowercased() } ?? ""
    }

    /// Width over height of an SVG, from its `viewBox`, else its `width` and `height` attributes. Nil when neither
    /// gives a usable size, such as percentages.
    public static func svgAspectRatio(_ xml: String) -> Double? {
        guard let tag = xml.firstMatch(of: /<svg\b[^>]*>/.ignoresCase())?.output else { return nil }
        let viewBox = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.ignoresCase()
        let width: Double?
        let height: Double?
        if let match = tag.firstMatch(of: viewBox) {
            width = Double(match.1)
            height = Double(match.2)
        } else {
            width = tag.firstMatch(of: /\swidth\s*=\s*["']([\d.]+)(?:px)?["']/.ignoresCase()).flatMap { Double($0.1) }
            height = tag.firstMatch(of: /\sheight\s*=\s*["']([\d.]+)(?:px)?["']/.ignoresCase()).flatMap { Double($0.1) }
        }
        guard let width, let height, width > 0, height > 0 else { return nil }
        return width / height
    }
}
