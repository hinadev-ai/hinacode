// The phone composer's use of the syntax (`apps/mobile/src/lib/composer-text.ts`): flat spans to tint the text, and
// the edits the desktop's skill chip makes.
extension ComposerSyntax {
    /// The desktop composer's highlighting as flat spans: the skill that starts the message, then the rest with each
    /// fenced block as one code span. Joining the spans gives back `text`.
    public static func spans(_ text: String, commands: [AgentCommand], known: KnownTokens) -> [Span] {
        let skill = leadingSkill(text, commands: commands)
        let rest = String(text.unicodeScalars.dropFirst(skill?.token.unicodeScalars.count ?? 0))
        let spans = highlight(rest, known: known).map { segment in
            switch segment {
            case .span(let span): span
            case .fence(let fence): Span(kind: .code, text: fence.text)
            }
        }
        guard let skill else { return spans }
        // The space that ends the skill's name stays text, so the tint covers only the name.
        return [Span(kind: .skill, text: String(skill.token.dropLast())), Span(kind: .text, text: " ")] + spans
    }

    /// The text after an edit, with the skill that started `before` removed whole when the edit deleted part of it,
    /// as Backspace after the desktop's skill chip does. Other edits come back as they are.
    public static func keepSkillWhole(before: String, after: String, commands: [AgentCommand]) -> String {
        guard let skill = leadingSkill(before, commands: commands) else { return after }
        let old = Array(before.unicodeScalars)
        let new = Array(after.unicodeScalars)
        guard !new.starts(with: skill.token.unicodeScalars), new.count < old.count else { return after }
        var start = 0
        while start < new.count, old[start] == new[start] { start += 1 }
        let end = start + old.count - new.count
        let isDeletion = old[end...].elementsEqual(new[start...])
        guard isDeletion else { return after }
        return String(String.UnicodeScalarView(old[max(end, skill.token.unicodeScalars.count)...]))
    }

    /// Where the caret goes after an edit turned `before` into `after`: right after the span that changed, as a
    /// UTF-16 offset into `after`.
    public static func caretAfterEdit(before: String, after: String) -> Int {
        let old = Array(before.unicodeScalars)
        let new = Array(after.unicodeScalars)
        var prefix = 0
        while prefix < old.count, prefix < new.count, old[prefix] == new[prefix] { prefix += 1 }
        var suffix = 0
        let maxSuffix = min(old.count, new.count) - prefix
        while suffix < maxSuffix, old[old.count - 1 - suffix] == new[new.count - 1 - suffix] { suffix += 1 }
        return new[..<(new.count - suffix)].reduce(0) { $0 + UTF16.width($1) }
    }
}
