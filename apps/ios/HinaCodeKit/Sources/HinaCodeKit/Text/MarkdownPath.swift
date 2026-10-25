import Foundation

/// Resolves the links and image sources of Markdown to files in a thread's workspace
/// (`apps/mobile/src/lib/markdown-paths.ts`). A resolved path is `/`-separated, relative to `root`, with no `.`,
/// `..` or empty segments, which is the only form `fs.preview` and `fs.read` accept.
public enum MarkdownPath {
    public enum ImageSource: Hashable, Sendable {
        /// A URL to load directly.
        case uri(String)
        /// A file to load with `fs.preview`.
        case file(root: String, path: String)
        case unavailable(Unavailable)
    }

    public enum Unavailable: Hashable, Sendable {
        case noRoot, outsideRoot, invalid
    }

    /// Where a Markdown image's `src` loads from. URLs load directly; a path loads from `root`, the thread's working
    /// folder, and must stay inside it. `folder` is where the Markdown itself sits, for a file previewed from the
    /// workspace; a reply's paths start at the root.
    public static func imageSource(_ src: String, root: String?, folder: String = "") -> ImageSource {
        let trimmed = src.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") || lower.hasPrefix("data:") {
            return .uri(trimmed)
        }
        if trimmed.isEmpty { return .unavailable(.invalid) }
        guard let root else { return .unavailable(.noRoot) }
        return switch relativeToRoot(trimmed, root: root, folder: folder) {
        case .path(let path): .file(root: root, path: path)
        case .unavailable(let reason): .unavailable(reason)
        }
    }

    /// The file a Markdown link points at, relative to `root`, or nil when it is not a file in it. A `#L10` line
    /// anchor is dropped.
    public static func fileLink(_ href: String, root: String?, folder: String = "") -> String? {
        guard let root, case .path(let path) = relativeToRoot(href, root: root, folder: folder) else { return nil }
        return path
    }

    private enum Relative {
        case path(String)
        case unavailable(Unavailable)
    }

    private static func relativeToRoot(_ href: String, root: String, folder: String) -> Relative {
        var path = href.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.lowercased().hasPrefix("file://") {
            path.removeFirst("file://".count)
            if path.lowercased().hasPrefix("localhost/") { path.removeFirst("localhost".count) }
        } else if path.prefixMatch(of: /[a-z][a-z0-9+.\-]*:/.ignoresCase()) != nil {
            return .unavailable(.invalid)
        }
        let withoutQuery = path.prefix { $0 != "?" && $0 != "#" }
        guard !withoutQuery.isEmpty, let decoded = withoutQuery.removingPercentEncoding,
            !decoded.unicodeScalars.contains("\0")
        else { return .unavailable(.invalid) }

        let segments: [Substring]
        if decoded.hasPrefix("/") {
            guard let absolute = normalize(decoded.split(separator: "/")),
                let base = normalize(root.split(separator: "/")), absolute.starts(with: base)
            else { return .unavailable(.outsideRoot) }
            segments = Array(absolute.dropFirst(base.count))
        } else {
            guard let relative = normalize(folder.split(separator: "/") + decoded.split(separator: "/")) else {
                return .unavailable(.outsideRoot)
            }
            segments = relative
        }
        return segments.isEmpty ? .unavailable(.invalid) : .path(segments.joined(separator: "/"))
    }

    /// `.` dropped and `..` popped. Nil when `..` climbs above the first segment.
    private static func normalize(_ segments: [Substring]) -> [Substring]? {
        var out: [Substring] = []
        for segment in segments where segment != "." {
            if segment != ".." {
                out.append(segment)
            } else if out.popLast() == nil {
                return nil
            }
        }
        return out
    }
}
