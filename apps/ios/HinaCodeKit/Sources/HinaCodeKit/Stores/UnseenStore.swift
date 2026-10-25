import Observation

/// Threads whose latest turn ended while the developer was not looking, until they open the thread. Kept in memory:
/// the phone only hears turns end while it runs, and losing the marks costs a look at each thread.
@MainActor
@Observable
public final class UnseenStore {
    public enum Outcome: Sendable {
        case completed, failed
    }

    public private(set) var outcomes: [String: Outcome] = [:]

    public init() {}

    public func record(_ outcome: Outcome, threadId: String) {
        outcomes[threadId] = outcome
    }

    public func clear(threadId: String) {
        if outcomes[threadId] != nil { outcomes[threadId] = nil }
    }
}
