import HinaCodeKit
import Testing

private let commands = [
    AgentCommand(
        trigger: .init(rawValue: "/"), name: "triage-issue", description: "", argumentHint: "", scope: .project),
    AgentCommand(trigger: .init(rawValue: "/"), name: "compact", description: "", argumentHint: "", builtin: true),
]
private let known = ComposerSyntax.KnownTokens(
    commands: ["/triage-issue", "/compact"],
    files: ["src/login.ts"],
    threads: []
)

private func span(_ kind: ComposerSyntax.Kind, _ text: String) -> ComposerSyntax.Span {
    ComposerSyntax.Span(kind: kind, text: text)
}

@Suite struct ComposerSpansTests {
    @Test("marks a leading skill, known mentions and code, and keeps every character")
    func marksAndKeepsText() {
        let text = "/triage-issue the login fails, see @src/login.ts and `npm test`\n```\nnpm test\n```"
        let spans = ComposerSyntax.spans(text, commands: commands, known: known)
        #expect(spans.map(\.text).joined() == text)
        #expect(
            spans.filter { $0.kind != .text } == [
                span(.skill, "/triage-issue"),
                span(.mention, "@src/login.ts"),
                span(.code, "`npm test`"),
                span(.code, "```\nnpm test\n```"),
            ])
    }

    @Test("leaves a built-in command and a skill that does not start the message as commands")
    func commandsThatAreNotSkills() {
        #expect(
            ComposerSyntax.spans("/compact now", commands: commands, known: known).first == span(.command, "/compact"))
        #expect(
            ComposerSyntax.spans("run /triage-issue", commands: commands, known: known).last
                == span(.command, "/triage-issue"))
    }
}

@Suite struct ComposerKeepSkillWholeTests {
    let before = "/triage-issue the login test"

    @Test("removes the whole skill when a deletion cuts into it, and keeps the text")
    func removesWholeSkill() {
        #expect(
            ComposerSyntax.keepSkillWhole(before: before, after: "/triage-issuethe login test", commands: commands)
                == "the login test")
        #expect(
            ComposerSyntax.keepSkillWhole(before: before, after: "/triage-isse the login test", commands: commands)
                == "the login test")
        #expect(
            ComposerSyntax.keepSkillWhole(before: before, after: "/triage-ogin test", commands: commands) == "ogin test"
        )
    }

    @Test("leaves other edits alone")
    func leavesOtherEdits() {
        #expect(
            ComposerSyntax.keepSkillWhole(before: before, after: "/triage-issue the login", commands: commands)
                == "/triage-issue the login")
        #expect(
            ComposerSyntax.keepSkillWhole(before: before, after: "/triage-issuex the login test", commands: commands)
                == "/triage-issuex the login test")
        #expect(
            ComposerSyntax.keepSkillWhole(before: "/compact now", after: "/compac now", commands: commands)
                == "/compac now")
        #expect(ComposerSyntax.keepSkillWhole(before: before, after: "", commands: commands) == "")
    }
}

@Suite struct ComposerCaretAfterEditTests {
    @Test("puts the caret after the change as a UTF-16 offset, never inside an emoji")
    func caretAfterChange() {
        #expect(ComposerSyntax.caretAfterEdit(before: "/triage-issue the login test", after: "the login test") == 0)
        #expect(ComposerSyntax.caretAfterEdit(before: "😁", after: "😀😁") == 2)
    }
}
