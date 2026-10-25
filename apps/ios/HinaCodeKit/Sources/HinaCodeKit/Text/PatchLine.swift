/// One row of a diff (`apps/mobile/src/lib/patch-lines.ts`). Hunk headers and notes such as "No newline at end of
/// file" have no line numbers.
public struct PatchLine: Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        case hunk, note, context, addition, deletion
    }

    public let kind: Kind
    public let text: String
    public let oldLine: Int?
    public let newLine: Int?

    public init(kind: Kind, text: String, oldLine: Int?, newLine: Int?) {
        self.kind = kind
        self.text = text
        self.oldLine = oldLine
        self.newLine = newLine
    }

    /// One file's section of a unified diff as numbered lines, from its first hunk on.
    public static func lines(of patch: String) -> [PatchLine] {
        let hunkHeader = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.asciiOnlyDigits()
        var lines: [PatchLine] = []
        var oldLine = 0
        var newLine = 0
        var inHunk = false
        for scalars in patch.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false) {
            let text = String(scalars)
            let rest = String(scalars.dropFirst())
            if let header = text.prefixMatch(of: hunkHeader) {
                inHunk = true
                oldLine = Int(header.1) ?? 0
                newLine = Int(header.2) ?? 0
                lines.append(PatchLine(kind: .hunk, text: text, oldLine: nil, newLine: nil))
            } else if !inHunk {
                continue
            } else if scalars.first == "+" {
                lines.append(PatchLine(kind: .addition, text: rest, oldLine: nil, newLine: newLine))
                newLine += 1
            } else if scalars.first == "-" {
                lines.append(PatchLine(kind: .deletion, text: rest, oldLine: oldLine, newLine: nil))
                oldLine += 1
            } else if scalars.first == "\\" {
                lines.append(PatchLine(kind: .note, text: text, oldLine: nil, newLine: nil))
            } else if scalars.first == " " {
                lines.append(PatchLine(kind: .context, text: rest, oldLine: oldLine, newLine: newLine))
                oldLine += 1
                newLine += 1
            }
        }
        return lines
    }
}
