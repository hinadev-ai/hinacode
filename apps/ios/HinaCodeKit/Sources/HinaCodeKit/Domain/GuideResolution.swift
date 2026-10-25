/// A pull request guide matched to the pull request's files as they are now. The guide may describe an older head, so
/// a path that left the diff is dropped, a path named twice stays in its first group, and a file no group names ends
/// up in `others`.
public struct GuideResolution: Hashable, Sendable {
    public struct File: Hashable, Sendable {
        public var file: PullRequestFile
        public var fileNotes: [GuideFileNote]
        public var lineNotesInHunks: [GuideLineNote]
        /// Notes on lines the diff does not show, so the view lists them with the file notes.
        public var lineNotesOutsideHunks: [GuideLineNote]
    }

    public struct Group: Hashable, Sendable {
        /// Unique in the resolution, even when the guide repeats one.
        public var key: String
        public var label: String
        /// Markdown.
        public var summary: String?
        public var category: GuideCategory
        /// The group, one of its notes or one of its children is critical.
        public var containsCritical: Bool
        /// The group's own files, without its children's.
        public var files: [File]
        public var children: [Group]

        /// Own files, then the children's, for the group's count and line totals.
        public var allFiles: [File] { files + children.flatMap(\.allFiles) }
    }

    public var groups: [Group]
    /// Files no group names, without notes, in the pull request's order.
    public var others: [File]

    public init(guide: PullRequestGuide, files: [PullRequestFile]) {
        var byPath: [String: PullRequestFile] = [:]
        for file in files {
            if let previousPath = file.previousPath { byPath[previousPath] = file }
        }
        for file in files { byPath[file.path] = file }
        var placed: Set<String> = []
        var keys: Set<String> = []

        func uniqueKey(_ key: String) -> String {
            var unique = key
            var count = 2
            while keys.contains(unique) {
                unique = "\(key)-\(count)"
                count += 1
            }
            keys.insert(unique)
            return unique
        }

        func resolveFiles(_ group: GuideGroup) -> [File] {
            group.filePaths.compactMap { path in
                guard let file = byPath[path], !placed.contains(file.path) else { return nil }
                placed.insert(file.path)
                let owns = { (notePath: String) in notePath == path || notePath == file.path }
                let lineNotes = (group.lineNotes ?? []).filter { owns($0.path) }
                return File(
                    file: file, fileNotes: (group.fileNotes ?? []).filter { owns($0.path) },
                    lineNotesInHunks: lineNotes.filter { hunkShows($0, in: file.patch) },
                    lineNotesOutsideHunks: lineNotes.filter { !hunkShows($0, in: file.patch) })
            }
        }

        func resolveGroup(_ group: GuideGroup) -> Group? {
            let key = uniqueKey(group.key)
            let own = resolveFiles(group)
            let children = (group.children ?? []).compactMap { child in
                resolveGroup(
                    GuideGroup(
                        key: child.key, label: child.label, summary: child.summary, category: child.category,
                        critical: child.critical, filePaths: child.filePaths, fileNotes: child.fileNotes,
                        lineNotes: child.lineNotes))
            }
            if own.isEmpty && children.isEmpty { return nil }
            let criticalNote = own.contains { entry in
                entry.fileNotes.contains { $0.critical == true }
                    || (entry.lineNotesInHunks + entry.lineNotesOutsideHunks).contains { $0.critical == true }
            }
            return Group(
                key: key, label: group.label, summary: group.summary, category: group.category,
                containsCritical: group.critical == true || criticalNote
                    || children.contains(where: \.containsCritical),
                files: own, children: children)
        }

        groups = guide.groups.compactMap(resolveGroup)
        others = files.filter { !placed.contains($0.path) }.map {
            File(file: $0, fileNotes: [], lineNotesInHunks: [], lineNotesOutsideHunks: [])
        }
    }
}

/// The note's line is inside some hunk's range on its side, `[start, start + count)`, the count defaulting to 1.
private func hunkShows(_ note: GuideLineNote, in patch: String) -> Bool {
    let header = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/.anchorsMatchLineEndings()
    return patch.matches(of: header).contains { hunk in
        let (start, count) = note.side == .additions ? (hunk.output.3, hunk.output.4) : (hunk.output.1, hunk.output.2)
        let first = Double(start) ?? 0
        return note.line >= first && note.line < first + (count.flatMap { Double($0) } ?? 1)
    }
}
