import HinaCodeKit
import Testing

struct ThreadRowStateTests {
    @Test func `shows an unopened result only on an idle thread`() {
        #expect(ThreadRowState(status: .idle, unseen: .completed) == .unseenCompleted)
        #expect(ThreadRowState(status: .idle, unseen: .failed) == .unseenFailed)
        #expect(ThreadRowState(status: .idle, unseen: nil) == .idle)
        #expect(ThreadRowState(status: .running, unseen: .completed) == .running)
    }

    @Test func `marks a finished or failed turn, not a limited one`() {
        #expect(ThreadOutcome(event: .turnCompleted(.init())) == .completed)
        #expect(ThreadOutcome(event: .turnFailed(.init(message: "boom"))) == .failed)
        #expect(ThreadOutcome(event: .turnLimited(.init(limit: .usage(.init(message: "Usage limit"))))) == nil)
        #expect(ThreadOutcome(event: .textDelta(.init(text: "hi"))) == nil)
    }

    @Test func `shows checks only while the pull request is open or a draft`() {
        #expect(PullRequestMark(number: "1", status: .open, checks: .failing).openChecks == .failing)
        #expect(PullRequestMark(number: "1", status: .draft, checks: .pending).openChecks == .pending)
        #expect(PullRequestMark(number: "1", status: .merged, checks: .failing).openChecks == nil)
        #expect(PullRequestMark(number: "1", status: nil, checks: nil).openChecks == nil)
    }
}
