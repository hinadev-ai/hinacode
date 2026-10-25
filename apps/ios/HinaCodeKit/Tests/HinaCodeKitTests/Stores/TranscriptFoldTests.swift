import Testing

@testable import HinaCodeKit

private let now = "2026-10-12T00:00:01.000Z"

private func assistant(_ id: String, _ parts: [MessagePart] = []) -> Message {
    Message(id: id, threadId: "t1", role: .assistant, parts: parts, createdAt: "2026-10-12T00:00:00.000Z")
}

private func user(_ id: String) -> Message {
    var message = assistant(id, [.text(.init(text: "hi"))])
    message.role = .user
    return message
}

private func text(_ text: String) -> MessagePart {
    .text(.init(text: text))
}

private func runningTool(_ callId: String, _ name: String) -> MessagePart {
    .toolCall(.init(callId: callId, name: name, input: .object([:]), status: .running))
}

private func toolCall(_ part: MessagePart?) -> MessagePart.ToolCall? {
    guard case .toolCall(let call) = part else { return nil }
    return call
}

private func compaction(_ state: Compaction) -> AgentEvent {
    .compactionUpdated(.init(compaction: state))
}

@Suite("foldEvent")
struct TranscriptFoldEventTests {
    @Test("streams consecutive deltas of one kind into a single part")
    func streamsDeltas() {
        let events: [AgentEvent] = [
            .textDelta(.init(text: "Hel")),
            .textDelta(.init(text: "lo")),
            .reasoningDelta(.init(text: "why")),
            .textDelta(.init(text: "!")),
        ]
        let folded = events.reduce(assistant("m1")) { foldEvent($0, $1, now: now) }
        #expect(folded.parts == [text("Hello"), .reasoning(.init(text: "why")), text("!")])
    }

    @Test("a tool call runs until its result arrives")
    func toolCallRuns() {
        let started = foldEvent(
            assistant("m1"), .toolCallStarted(.init(callId: "c1", name: "Read", input: .object([:]))), now: now)
        #expect(started.parts == [runningTool("c1", "Read")])
        let finished = foldEvent(
            started, .toolCallFinished(.init(callId: "c1", output: .string("ok"), isError: false)), now: now)
        #expect(toolCall(finished.parts.first)?.status == .done)
        #expect(toolCall(finished.parts.first)?.output == .string("ok"))
        let failed = foldEvent(
            started, .toolCallFinished(.init(callId: "c1", output: .string("boom"), isError: true)), now: now)
        #expect(toolCall(failed.parts.first)?.status == .error)
    }

    @Test("turn_completed closes the message and fails tools still running")
    func turnCompleted() {
        let running = assistant("m1", [runningTool("c1", "Bash")])
        let usage = TokenUsage(inputTokens: 1, outputTokens: 2)
        let done = foldEvent(running, .turnCompleted(.init(usage: usage)), now: now)
        #expect(done.completedAt == now)
        #expect(done.usage == usage)
        #expect(toolCall(done.parts.first)?.status == .error)
    }

    @Test("turn_failed appends the error to the transcript")
    func turnFailed() {
        let failed = foldEvent(assistant("m1"), .turnFailed(.init(message: "Interrupted")), now: now)
        #expect(failed.parts == [text("**Error:** Interrupted")])
        #expect(failed.completedAt == now)
    }

    @Test("a limit ends every outstanding tool and retains the provider explanation")
    func turnLimited() {
        let messages = [assistant("m1", [runningTool("c1", "Bash")]), user("u2"), assistant("m3")]
        let next = foldTranscript(
            messages, .turnLimited(.init(limit: .orgSpend(.init(message: "Spend limit reached")))), now: now)
        #expect(toolCall(next[0].parts.first)?.status == .error)
        #expect(next[2].parts == [text("Spend limit reached")])
        #expect(next[2].completedAt == now)
    }

    @Test("events that do not touch the transcript return the same message")
    func untouched() {
        let message = assistant("m1")
        #expect(foldEvent(message, .sessionBound(.init(providerSessionId: "s")), now: now) == message)
        #expect(foldEvent(message, .approvalResolved(.init(requestId: "a")), now: now) == message)
    }
}

@Suite("foldEvent compaction")
struct TranscriptFoldCompactionTests {
    let done = Compaction.done(.init(trigger: .auto, preTokens: 160000, postTokens: 12000))

    @Test("a compaction runs in place until it reports back")
    func runsInPlace() {
        let running = foldEvent(assistant("m1", [text("hi")]), compaction(.running(.init())), now: now)
        let finished = foldEvent(running, compaction(done), now: now)
        #expect(finished.parts == [text("hi"), .compaction(.init(compaction: done))])
        #expect(foldEvent(finished, compaction(done), now: now).parts.count == 3)
    }

    @Test("a turn that ends mid-compaction fails it")
    func endsMidCompaction() {
        let running = foldEvent(assistant("m1"), compaction(.running(.init())), now: now)
        #expect(
            foldEvent(running, .turnCompleted(.init()), now: now).parts == [
                .compaction(.init(compaction: .failed(.init(message: nil))))
            ])
    }
}

@Suite("foldTranscript")
struct TranscriptFoldTranscriptTests {
    let steered = [assistant("m1", [runningTool("c1", "Bash")]), user("u2"), assistant("m3")]

    @Test("deltas go to the latest assistant message")
    func deltasGoToLatest() {
        let next = foldTranscript(steered, .textDelta(.init(text: "x")), now: now)
        #expect(next[2].parts == [text("x")])
        #expect(next[0] == steered[0])
    }

    @Test("a tool result lands in the message that holds the call, even after a steer")
    func toolResultAfterSteer() {
        let next = foldTranscript(
            steered, .toolCallFinished(.init(callId: "c1", output: .number(1), isError: false)), now: now)
        #expect(toolCall(next[0].parts.first)?.status == .done)
        #expect(next[2] == steered[2])
    }

    @Test("ending the turn fails running tools in every earlier message")
    func endingFailsEarlierTools() {
        let next = foldTranscript(steered, .turnCompleted(.init()), now: now)
        #expect(toolCall(next[0].parts.first)?.status == .error)
        #expect(next[2].completedAt == now)
    }

    @Test("a transcript without an assistant message is left alone")
    func withoutAssistant() {
        let only = [user("u1")]
        #expect(foldTranscript(only, .textDelta(.init(text: "x")), now: now) == only)
    }
}
