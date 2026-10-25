import HinaCodeKit
import Testing

private let approval = AgentEvent.approvalRequested(
    .init(
        request: ApprovalRequest(
            id: "a1", threadId: "t1", provider: .claude, kind: .command, title: "Run tests", detail: "pnpm test")))
private let question = AgentEvent.questionRequested(
    .init(request: QuestionRequest(id: "q1", threadId: "t1", provider: .claude, questions: [])))
private let secret = AgentEvent.secretRequested(
    .init(request: SecretRequest(id: "s1", threadId: "t1", name: "NPM_TOKEN", description: "Publish the package")))
private let usageLimit = AgentEvent.turnLimited(.init(limit: .orgSpend(.init(message: "Spend limit reached"))))

struct ThreadAlertTests {
    @Test(arguments: [
        (AgentEvent.turnCompleted(.init()), ThreadAlert(kind: .completed, body: .completed)),
        (approval, ThreadAlert(kind: .needsInput, body: .approval)),
        (question, ThreadAlert(kind: .needsInput, body: .question)),
        (secret, ThreadAlert(kind: .needsInput, body: .secret)),
        (
            .turnFailed(.init(message: "Network error")),
            ThreadAlert(kind: .failed, body: .failed(message: "Network error"))
        ),
        (usageLimit, ThreadAlert(kind: .failed, body: .limited)),
    ])
    func `raises a notice`(for event: AgentEvent, expected: ThreadAlert) {
        #expect(ThreadAlert(event: event) == expected)
    }

    @Test func `keeps only the first line of a failure`() {
        let event = AgentEvent.turnFailed(.init(message: "Process exited\n  at spawn\n  at run"))
        #expect(ThreadAlert(event: event) == ThreadAlert(kind: .failed, body: .failed(message: "Process exited")))
    }

    // Swift reads "\r\n" as one Character, so splitting on the Character "\n" would keep every line.
    @Test func `keeps only the first line of a failure with Windows line endings`() {
        let event = AgentEvent.turnFailed(.init(message: "Process exited\r\n  at spawn"))
        #expect(ThreadAlert(event: event) == ThreadAlert(kind: .failed, body: .failed(message: "Process exited\r")))
    }

    @Test(arguments: [
        AgentEvent.textDelta(.init(text: "Hello")),
        .approvalResolved(.init(requestId: "a1")),
        .questionResolved(.init(requestId: "q1")),
        .secretResolved(.init(requestId: "s1")),
        .sessionBound(.init(providerSessionId: "p1")),
    ])
    func `raises nothing`(for event: AgentEvent) {
        #expect(ThreadAlert(event: event) == nil)
    }
}
