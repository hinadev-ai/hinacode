/// How a thread's latest turn ended.
public enum ThreadOutcome: Hashable, Sendable {
    case completed
    case failed

    /// A usage limit already shows on the row as Limited, so only a finished or failed turn leaves a mark.
    public init?(event: AgentEvent) {
        switch event {
        case .turnCompleted: self = .completed
        case .turnFailed: self = .failed
        default: return nil
        }
    }
}

/// What a thread row shows: the thread's status, or for an idle thread, a result the developer has not opened yet.
/// The desktop sidebar draws from the same rules, in `src/shared/threadStatus.ts`.
public enum ThreadRowState: Hashable, Sendable {
    case idle
    case running
    case awaitingApproval
    case limited
    case archived
    case unseenCompleted
    case unseenFailed
    /// A status this build does not know yet. It rests, with no icon.
    case unknown(String)

    /// How loudly a row reads.
    public enum Emphasis: Hashable, Sendable {
        /// The thread needs the developer: full contrast.
        case attention
        /// A step down.
        case resting
        /// Muted and faded until the developer reaches for it.
        case working
    }

    public init(status: ThreadStatus, unseen: ThreadOutcome?) {
        switch status {
        case .idle:
            switch unseen {
            case .completed: self = .unseenCompleted
            case .failed: self = .unseenFailed
            case nil: self = .idle
            }
        case .running: self = .running
        case .awaitingApproval: self = .awaitingApproval
        case .limited: self = .limited
        case .archived: self = .archived
        case .unknown(let value): self = .unknown(value)
        }
    }

    public var emphasis: Emphasis {
        switch self {
        case .awaitingApproval, .limited, .unseenCompleted, .unseenFailed: .attention
        case .idle, .archived, .unknown: .resting
        case .running: .working
        }
    }

    /// The color of the row's status icon, or nil for the states that show none. The view picks the icon per state.
    public var indicatorTone: IndicatorTone? {
        switch self {
        case .running: .muted
        case .awaitingApproval, .limited: .attention
        case .unseenCompleted: .success
        case .unseenFailed: .danger
        case .idle, .archived, .unknown: nil
        }
    }
}

/// The color role of a status icon or pill, which each view maps to its theme. `success` is the phone's `running`
/// green, and `muted` is the text-muted gray a neutral pill uses.
public enum IndicatorTone: Hashable, Sendable {
    case muted
    case attention
    case success
    case danger
    case prOpen
    case prMerged
}

extension ThreadStatus {
    /// A turn is in flight: the agent may be writing to the thread's working directory.
    public var isBusy: Bool { self == .running || self == .awaitingApproval }
}
