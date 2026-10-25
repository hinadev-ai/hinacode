import Foundation

/// How long ago a time was in the largest whole unit, like the desktop sidebar: now, 5m ago, 3h ago, 2w ago.
/// The view maps each case to its String Catalog key (`mobile_time_now`, `mobile_time_minutes`, ...) with the count.
public enum RelativeTime: Hashable, Sendable {
    case now
    case minutes(Int)
    case hours(Int)
    case days(Int)
    case weeks(Int)
    case months(Int)
    case years(Int)

    /// `iso` is an ISO 8601 timestamp from the desktop, such as `updatedAt`.
    public init(since iso: String, now: Date) {
        let minute: TimeInterval = 60
        let hour = 60 * minute
        let day = 24 * hour
        let elapsed = (try? Date(iso, strategy: .iso8601)).map { now.timeIntervalSince($0) } ?? 0
        let count = { (unit: TimeInterval) in Int((elapsed / unit).rounded(.down)) }
        switch elapsed {
        // Anything under a minute, including a time slightly in the future from clock skew, is now.
        case ..<minute: self = .now
        case ..<hour: self = .minutes(count(minute))
        case ..<day: self = .hours(count(hour))
        case ..<(7 * day): self = .days(count(day))
        case ..<(30 * day): self = .weeks(count(7 * day))
        case ..<(365 * day): self = .months(count(30 * day))
        default: self = .years(count(365 * day))
        }
    }
}
