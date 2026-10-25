/// A pull request number in its state's color, as in the desktop sidebar: a stack when the thread linked several, the
/// state's icon, and the checks while the pull request is still open. Before the state loads, a muted icon.
public struct PullRequestMark: Hashable, Sendable {
    /// What a screen reader says for a mark, in order. The view localizes each part and joins them with commas.
    public enum LabelPart: Hashable, Sendable {
        /// "Pull request #{number}"
        case number(String)
        case status(PullRequestStatus)
        case checks(ChecksStatus)
        /// "{count} more linked"
        case more(Int)
    }

    public var number: String
    /// Nil, like `checks`, until GitHub answers.
    public var status: PullRequestStatus?
    public var checks: ChecksStatus?
    public var stacked: Bool

    public init(number: String, status: PullRequestStatus?, checks: ChecksStatus?, stacked: Bool = false) {
        self.number = number
        self.status = status
        self.checks = checks
        self.stacked = stacked
    }

    /// The color of the stack, the state icon and the number.
    public var tone: IndicatorTone { status?.tone ?? .muted }

    /// The checks worth showing next to the number: none once it has merged or closed, since nobody acts on them.
    public var openChecks: ChecksStatus? { status?.isOpen == true ? checks : nil }

    /// "Pull request #123, Open, Checks failing". `more` counts the thread's other linked pull requests.
    public func label(more: Int = 0) -> [LabelPart] {
        var parts: [LabelPart] = [.number(number)]
        if let status { parts.append(.status(status)) }
        if let checks { parts.append(.checks(checks)) }
        if more > 0 { parts.append(.more(more)) }
        return parts
    }
}

extension PullRequestStatus {
    public var isOpen: Bool { self == .open || self == .draft }

    /// The state as GitHub draws it.
    public var tone: IndicatorTone {
        switch self {
        case .open: .prOpen
        case .merged: .prMerged
        case .closed: .danger
        case .draft, .unknown: .muted
        }
    }
}

extension ChecksStatus {
    /// Only failing checks need the developer, so only they get a color. Amber would claim pending checks need them.
    public var tone: IndicatorTone {
        switch self {
        case .failing: .danger
        case .passing, .pending, .unknown: .muted
        }
    }
}

extension ReviewStatus {
    public var tone: IndicatorTone {
        switch self {
        case .approved: .success
        case .changesRequested: .attention
        case .reviewRequired, .unknown: .muted
        }
    }
}
