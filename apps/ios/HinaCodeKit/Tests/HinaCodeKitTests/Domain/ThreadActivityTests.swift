import Foundation
import HinaCodeKit
import Testing

private let start = Date(timeIntervalSince1970: 1_800_000_000)
private let later = start.addingTimeInterval(90)
private let working = ThreadActivityState.started(at: start)

private func tool(_ name: String, _ input: [String: JSONValue], parent: String? = nil) -> AgentEvent {
    .toolCallStarted(.init(callId: "c1", name: name, input: .object(input), parentCallId: parent))
}

private let approval = AgentEvent.approvalRequested(
    .init(
        request: ApprovalRequest(
            id: "a1", threadId: "t1", provider: .claude, kind: .command, title: "Run pnpm test", detail: "pnpm test")))
private let question = AgentEvent.questionRequested(
    .init(
        request: QuestionRequest(
            id: "q1", threadId: "t1", provider: .claude,
            questions: [
                Question(
                    id: "port", header: "Dev server", question: "Which port?", options: [], multiSelect: false,
                    allowsText: true, secret: false)
            ])))

struct ThreadActivityStateTests {
    @Test func `names the step a tool call starts`() {
        let next = working.applying(tool("Bash", ["command": .string("pnpm test\n--watch")]), at: later, queued: 0)
        #expect(next == ThreadActivityState(phase: .working, startedAt: start, detail: "Bash pnpm test"))
    }

    @Test func `ignores a subagent's tool calls`() {
        let next = working.applying(tool("Read", ["file_path": .string("a.ts")], parent: "c0"), at: later, queued: 0)
        #expect(next == working)
    }

    @Test(arguments: [(approval, "Run pnpm test"), (question, "Which port?")])
    func `turns to needs you with what it asks`(event: AgentEvent, detail: String) {
        let next = working.applying(event, at: later, queued: 0)
        #expect(next == ThreadActivityState(phase: .needsYou, startedAt: start, detail: detail))
    }

    @Test func `goes back to working once answered`() {
        let asking = working.applying(approval, at: later, queued: 0)
        let next = asking.applying(.approvalResolved(.init(requestId: "a1")), at: later, queued: 0)
        #expect(next == working)
    }

    @Test func `stops the clock when the turn ends`() {
        #expect(
            working.applying(.turnCompleted(.init()), at: later, queued: 0)
                == ThreadActivityState(phase: .finished, startedAt: start, endedAt: later))
        #expect(
            working.applying(.turnFailed(.init(message: "Process exited\n  at spawn")), at: later, queued: 0)
                == ThreadActivityState(phase: .failed, startedAt: start, endedAt: later, detail: "Process exited"))
    }

    @Test func `drops the last step once the turn finishes`() {
        let stepping = working.applying(tool("Read", ["file_path": .string("a.ts")]), at: later, queued: 0)
        #expect(stepping.applying(.turnCompleted(.init()), at: later, queued: 0).detail == nil)
    }

    @Test func `keeps working when messages wait behind a finished turn`() {
        #expect(working.applying(.turnCompleted(.init()), at: later, queued: 1) == working)
    }

    @Test func `leaves text and reasoning alone`() {
        #expect(working.applying(.textDelta(.init(text: "Hello")), at: later, queued: 0) == working)
    }

    @Test func `takes the phase a reload reports`() {
        #expect(working.reconciled(with: .awaitingApproval, at: later).phase == .needsYou)
        #expect(
            working.reconciled(with: .idle, at: later)
                == ThreadActivityState(phase: .finished, startedAt: start, endedAt: later))
        #expect(working.reconciled(with: .running, at: later) == working)
        let ended = ThreadActivityState(phase: .finished, startedAt: start, endedAt: later)
        #expect(ended.reconciled(with: .idle, at: later.addingTimeInterval(60)) == ended)
    }
}

private let early = "2026-10-16T00:00:00.000Z"

private func thread(_ id: String, status: ThreadStatus, updatedAt: String = early, projectId: String = "p")
    -> AgentThread
{
    AgentThread(
        id: id, projectId: projectId, worktreeId: nil, title: id, provider: .claude, model: "opus", fastMode: false,
        userSkills: false, accessMode: .supervised, status: status, sortIndex: 0, pinnedAt: nil, queue: [],
        createdBy: "user", createdAt: early, updatedAt: updatedAt)
}

private let project = Project(
    id: "p", name: "hinacode", rootPath: "/repo", createdAt: early, updatedAt: early, linearReview: false,
    kind: .folder)

struct WidgetSnapshotTests {
    @Test func `lists what needs the developer first and leaves quiet threads out`() {
        let snapshot = WidgetSnapshot(
            threads: [
                thread("running", status: .running),
                thread("idle", status: .idle),
                thread("done", status: .idle),
                thread("asking", status: .awaitingApproval),
                thread("broken", status: .idle),
                thread("archived", status: .archived),
            ],
            projects: [project],
            unseen: ["done": .completed, "broken": .failed],
            at: start)
        #expect(snapshot.threads.map(\.id) == ["asking", "broken", "done", "running"])
        #expect(snapshot.threads.map(\.state) == [.needsYou, .failed, .finished, .working])
        #expect(snapshot.threads.first?.project == "hinacode")
        #expect(snapshot.needsYou == 1)
        #expect(snapshot.working == 1)
    }

    @Test func `orders each group by the latest change and counts past the limit`() {
        let threads = (0..<8).map { index in
            thread("t\(index)", status: .running, updatedAt: "2026-10-16T00:0\(index):00.000Z")
        }
        let snapshot = WidgetSnapshot(threads: threads, projects: [project], unseen: [:], at: start)
        #expect(snapshot.threads.map(\.id) == ["t7", "t6", "t5", "t4", "t3", "t2"])
        #expect(snapshot.working == 8)
    }
}

struct ThreadLinkTests {
    @Test func `round-trips a thread id`() {
        let url = ThreadLink.url(threadId: "thread 1/2")
        #expect(ThreadLink.threadId(in: url) == "thread 1/2")
    }

    @Test func `ignores other links`() {
        #expect(ThreadLink.threadId(in: URL(string: "hinacode://connect?host=a&port=1&token=t")!) == nil)
        #expect(ThreadLink.threadId(in: URL(string: "hinacode://thread")!) == nil)
    }
}
