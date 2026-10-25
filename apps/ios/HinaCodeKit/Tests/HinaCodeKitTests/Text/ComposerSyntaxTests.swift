import Testing

@testable import HinaCodeKit

private typealias Segment = ComposerSyntax.Segment

private let known = ComposerSyntax.KnownTokens(
    commands: ["/kalan-mode", "$verify-hinacode"],
    files: ["src/main/ipc.ts"],
    threads: ["t-1"]
)

private func span(_ kind: ComposerSyntax.Kind, _ text: String) -> Segment {
    .span(ComposerSyntax.Span(kind: kind, text: text))
}

private func marked(_ segments: [Segment]) -> [Segment] {
    segments.filter {
        if case .span(let span) = $0 { span.kind != .text } else { true }
    }
}

private func command(_ trigger: String, _ name: String, builtin: Bool? = nil) -> AgentCommand {
    AgentCommand(
        trigger: AgentCommand.Trigger(rawValue: trigger), name: name, description: "", argumentHint: "",
        builtin: builtin)
}

private func thread(_ id: String, _ title: String) -> AgentThread {
    AgentThread(
        id: id, projectId: "p", title: title, provider: .claude, model: "m", fastMode: false, userSkills: false,
        accessMode: .supervised, status: .idle, sortIndex: 0, queue: [], createdBy: "user", createdAt: "",
        updatedAt: "")
}

@Suite struct ComposerHighlightTests {
    @Test("marks bullets, inline code and known commands, and keeps every character")
    func marksAndKeepsText() {
        let text =
            "This is kalan\n* item\n  - nested\n1. first\n`hello` and /kalan-mode\n/usr/bin is a path\n"
            + "see @src/main/ipc.ts, not @nope or a@b.c"
        let segments = ComposerSyntax.highlight(text, known: known)
        #expect(segments.map(\.text).joined() == text)
        #expect(
            marked(segments) == [
                span(.bullet, "*"),
                span(.bullet, "-"),
                span(.bullet, "1."),
                span(.code, "`hello`"),
                span(.command, "/kalan-mode"),
                span(.mention, "@src/main/ipc.ts"),
            ])
    }

    @Test("keeps a fenced block whole, with its language, and nothing inside it as a command")
    func fencedBlock() {
        let text = "run\n```ts title=a.ts\nconst a = 1\n/kalan-mode\n```\nafter"
        #expect(
            ComposerSyntax.highlight(text, known: known) == [
                span(.text, "run\n"),
                .fence(
                    ComposerSyntax.Fence(
                        language: "ts", open: "```ts title=a.ts", lines: ["const a = 1", "/kalan-mode"], close: "```")),
                span(.text, "\nafter"),
            ])
    }

    @Test("keeps every character of empty and unclosed fences")
    func emptyAndUnclosedFences() {
        for text in ["```\n```", "```\n\n```", "```py", "```py\nx = 1\n"] {
            #expect(ComposerSyntax.highlight(text, known: known).map(\.text).joined() == text)
        }
    }

    @Test("marks mentions of known threads only")
    func knownThreadMentions() {
        #expect(
            marked(ComposerSyntax.highlight("ask @thread:t-1. and @thread:t-2", known: known)) == [
                span(.mention, "@thread:t-1")
            ])
    }

    @Test("leaves an unclosed backtick as text")
    func unclosedBacktick() {
        #expect(ComposerSyntax.highlight("a `b", known: known) == [span(.text, "a `b")])
    }
}

@Suite struct ComposerCompletionTests {
    private typealias Completion = ComposerSyntax.Completion

    @Test("finds the command being typed at the caret, at line start or after a space")
    func findsToken() {
        #expect(
            ComposerSyntax.completion(in: "/kal", caret: 4)
                == Completion(trigger: .slash, query: "kal", start: 0, end: 4))
        #expect(
            ComposerSyntax.completion(in: "use $ver now", caret: 8)
                == Completion(trigger: .dollar, query: "ver", start: 4, end: 8))
        #expect(
            ComposerSyntax.completion(in: "read @src/ma", caret: 12)
                == Completion(trigger: .at, query: "src/ma", start: 5, end: 12))
        #expect(
            ComposerSyntax.completion(in: "see #26", caret: 7)
                == Completion(trigger: .hash, query: "26", start: 4, end: 7))
    }

    @Test("covers the whole token when the caret is inside it")
    func wholeToken() {
        #expect(
            ComposerSyntax.completion(in: "x /kalan-mode y", caret: 5)
                == Completion(trigger: .slash, query: "ka", start: 2, end: 13))
    }

    @Test("ignores triggers inside words and after whitespace has been typed")
    func ignoresInsideWords() {
        #expect(ComposerSyntax.completion(in: "src/foo", caret: 7) == nil)
        #expect(ComposerSyntax.completion(in: "a@b.c", caret: 5) == nil)
        #expect(ComposerSyntax.completion(in: "/kalan-mode ", caret: 12) == nil)
        #expect(ComposerSyntax.completion(in: "plain", caret: 5) == nil)
        #expect(ComposerSyntax.completion(in: "a#1", caret: 3) == nil)
    }

    @Test("leaves a Markdown heading alone")
    func markdownHeading() {
        #expect(ComposerSyntax.completion(in: "## Plan", caret: 2) == nil)
        #expect(
            ComposerSyntax.completion(in: "# Plan", caret: 1) == Completion(trigger: .hash, query: "", start: 0, end: 1)
        )
    }

    @Test("counts offsets in UTF-16 code units past emoji and CJK, and inserts at them")
    func utf16Offsets() {
        let text = "日本😀 @src/ma"
        let completion = ComposerSyntax.completion(in: text, caret: 12)
        #expect(completion == Completion(trigger: .at, query: "src/ma", start: 5, end: 12))
        #expect(
            completion?.inserting(.file("src/main.ts"), into: text)
                == ComposerSyntax.Edit(text: "日本😀 @src/main.ts ", caret: 18))
    }
}

@Suite struct ComposerLeadingSkillTests {
    let commands = [
        command("/", "compact", builtin: true), command("/", "kalan-mode"), command("$", "verify-hinacode"),
    ]

    @Test("finds the skill whose token and a space start the text")
    func findsSkill() {
        #expect(
            ComposerSyntax.leadingSkill("/kalan-mode fix it", commands: commands)
                == ComposerSyntax.Skill(command: command("/", "kalan-mode"), token: "/kalan-mode "))
        #expect(ComposerSyntax.leadingSkill("$verify-hinacode ", commands: commands)?.token == "$verify-hinacode ")
    }

    @Test("ignores a skill still being typed, one later in the text, and the agent's own commands")
    func ignoresOthers() {
        #expect(ComposerSyntax.leadingSkill("/kalan-mode", commands: commands) == nil)
        #expect(ComposerSyntax.leadingSkill("/kalan-mode\nfix it", commands: commands) == nil)
        #expect(ComposerSyntax.leadingSkill("use /kalan-mode now", commands: commands) == nil)
        #expect(ComposerSyntax.leadingSkill("/kalan-modes ", commands: commands) == nil)
        #expect(ComposerSyntax.leadingSkill("/compact now", commands: commands) == nil)
    }
}

@Suite struct ComposerMatchFilesTests {
    let files = ["src/main/ipc.ts", "src/renderer/lib/rpc.ts", "docs/ipc-notes.md", "README.md"]

    @Test("ranks file names starting with the query, then names containing it, then paths containing it")
    func ranks() {
        #expect(ComposerSyntax.matchFiles(files, query: "ipc") == ["src/main/ipc.ts", "docs/ipc-notes.md"])
        #expect(ComposerSyntax.matchFiles(files, query: "rpc") == ["src/renderer/lib/rpc.ts"])
        #expect(ComposerSyntax.matchFiles(files, query: "renderer/") == ["src/renderer/lib/rpc.ts"])
    }

    @Test("lists the shortest paths first for an empty query")
    func emptyQuery() {
        #expect(ComposerSyntax.matchFiles(files, query: "").first == "README.md")
    }
}

@Suite struct ComposerMatchThreadsTests {
    let threads = [thread("a", "Refactor login form"), thread("b", "Login flaky test"), thread("c", "Docs")]

    @Test("ranks titles starting with the query before titles containing it, ignoring case")
    func ranks() {
        #expect(ComposerSyntax.matchThreads(threads, query: "login").map(\.id) == ["b", "a"])
    }

    @Test("keeps the given order for an empty query")
    func emptyQuery() {
        #expect(ComposerSyntax.matchThreads(threads, query: "").map(\.id) == ["a", "b", "c"])
    }
}
