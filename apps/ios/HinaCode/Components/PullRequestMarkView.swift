import HinaCodeKit
import SwiftUI

/// A pull request number in its state's color, as thread rows and the thread header draw it: a stack mark when the
/// thread linked several, the state's symbol, the number, and the checks while it is still open.
struct PullRequestMarkView: View {
    let mark: PullRequestMark

    var body: some View {
        HStack(spacing: 3) {
            if mark.stacked {
                Image(systemName: "square.stack.3d.up")
            }
            Image(systemName: Self.symbol(for: mark.status))
            Text(verbatim: "#\(mark.number)")
                .monospacedDigit()
            if let checks = mark.openChecks {
                Image(systemName: Self.symbol(for: checks))
                    .foregroundStyle(checks.tone.color)
            }
        }
        .foregroundStyle(mark.tone.color)
        .accessibilityHidden(true)
    }

    static func symbol(for status: PullRequestStatus?) -> String {
        switch status {
        case .merged: "arrow.triangle.merge"
        case .closed: "xmark.circle"
        case .open, .draft, .unknown, nil: "arrow.triangle.branch"
        }
    }

    static func symbol(for checks: ChecksStatus) -> String {
        switch checks {
        case .passing: "checkmark.circle.fill"
        case .failing: "xmark.circle.fill"
        case .pending, .unknown: "clock"
        }
    }
}

extension PullRequestStatus {
    var label: LocalizedStringResource {
        switch self {
        case .open: .mobilePrStateOpen
        case .draft: .mobilePrStateDraft
        case .merged: .mobilePrStateMerged
        case .closed: .mobilePrStateClosed
        case .unknown: .mobilePrStateOpen
        }
    }
}

extension ChecksStatus {
    var label: LocalizedStringResource {
        switch self {
        case .passing: .mobilePrChecksPassing
        case .failing: .mobilePrChecksFailing
        case .pending, .unknown: .mobilePrChecksPending
        }
    }
}

extension PullRequestMark {
    /// The mark read aloud, part by part, for a thread row's accessibility label: the number (with the stack size
    /// when several are linked), then the state and the checks.
    func spokenParts(more: Int = 0) -> [String] {
        label(more: more).compactMap { part in
            switch part {
            case .number(let number):
                more > 0
                    ? String(localized: .mobileRowPullRequestStack(number, String(more + 1)))
                    : String(localized: .mobileRowPullRequest(number))
            case .status(let status): String(localized: status.label)
            case .checks(let checks): String(localized: checks.label)
            case .more: nil
            }
        }
    }
}
