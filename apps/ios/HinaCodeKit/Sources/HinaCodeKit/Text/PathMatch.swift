/// A workspace path that matched a "go to file" query (`apps/mobile/src/lib/path-match.ts`).
public struct PathMatch: Hashable, Sendable {
    public let path: String
    /// UTF-16 offsets into `path` of the characters the query matched, ascending, for bolding.
    public let positions: [Int]
    public let score: Int

    private static let maxResults = 50
    private static let basenameBonus = 1000
    private static let consecutiveBonus = 10
    private static let boundaryBonus = 6

    /// Ranks `paths` for `query`: its characters must appear in order, case-insensitively. A hit inside the file
    /// name ranks above one that needs the folders, and whitespace in the query is ignored. Returns at most 50
    /// matches, best first; ties go to the shorter path.
    public static func matches(_ paths: [String], query: String) -> [PathMatch] {
        let needle = query.utf16.filter { !isSpace($0) }.map(lowercase)
        guard !needle.isEmpty else { return [] }
        let matches = paths.compactMap { match($0, needle) }.sorted { a, b in
            if a.score != b.score { return a.score > b.score }
            if a.path.utf16.count != b.path.utf16.count { return a.path.utf16.count < b.path.utf16.count }
            return a.path < b.path
        }
        return Array(matches.prefix(maxResults))
    }

    private static func match(_ path: String, _ needle: [UInt16]) -> PathMatch? {
        let text = Array(path.utf16)
        let lower = text.map(lowercase)
        let nameStart = (text.lastIndex(of: UInt16(UInt8(ascii: "/"))) ?? -1) + 1
        if let inName = subsequence(text[nameStart...], lower[nameStart...], needle) {
            return PathMatch(path: path, positions: inName.positions, score: basenameBonus + inName.score)
        }
        return subsequence(text[...], lower[...], needle).map {
            PathMatch(path: path, positions: $0.positions, score: $0.score)
        }
    }

    /// The best placement of `query` as a subsequence of `text`, trying every start of its first character and
    /// matching the rest greedily. Earlier, consecutive and word-start matches score higher. Positions are indices
    /// of the slices' base array.
    private static func subsequence(
        _ text: ArraySlice<UInt16>, _ lower: ArraySlice<UInt16>, _ query: [UInt16]
    ) -> (positions: [Int], score: Int)? {
        var best: (positions: [Int], score: Int)?
        var candidate = lower.firstIndex(of: query[0])
        while let start = candidate {
            var positions = [start]
            for unit in query.dropFirst() {
                guard let found = lower[(positions[positions.count - 1] + 1)...].firstIndex(of: unit) else {
                    return best
                }
                positions.append(found)
            }
            var score = lower.startIndex - start
            for (index, position) in positions.enumerated() {
                if index > 0, position == positions[index - 1] + 1 { score += consecutiveBonus }
                if isBoundary(text, position) { score += boundaryBonus }
            }
            if score > best?.score ?? .min { best = (positions, score) }
            candidate = lower[(start + 1)...].firstIndex(of: query[0])
        }
        return best
    }

    private static func isBoundary(_ text: ArraySlice<UInt16>, _ index: Int) -> Bool {
        if index == text.startIndex { return true }
        let before = text[index - 1]
        if "/.-_ ".utf16.contains(before) { return true }
        return !changesWhenLowercased(before) && changesWhenLowercased(text[index])
    }

    private static func isSpace(_ unit: UInt16) -> Bool {
        Unicode.Scalar(unit)?.properties.isWhitespace ?? false
    }

    private static func changesWhenLowercased(_ unit: UInt16) -> Bool {
        Unicode.Scalar(unit)?.properties.changesWhenLowercased ?? false
    }

    /// Lowercases one code unit, keeping it when its lowercase takes more or fewer units, so positions found in
    /// the lowercased path index the path itself.
    private static func lowercase(_ unit: UInt16) -> UInt16 {
        if unit < 0x80 { return (0x41...0x5A).contains(unit) ? unit + 0x20 : unit }
        guard let scalar = Unicode.Scalar(unit) else { return unit }
        let lower = Array(scalar.properties.lowercaseMapping.utf16)
        return lower.count == 1 ? lower[0] : unit
    }
}
