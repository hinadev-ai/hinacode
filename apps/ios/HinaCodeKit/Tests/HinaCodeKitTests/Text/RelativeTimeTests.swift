import Foundation
import HinaCodeKit
import Testing

private let now = try! Date("2026-10-18T12:00:00.000Z", strategy: .iso8601)
private let day: TimeInterval = 86_400

private func ago(_ seconds: TimeInterval) -> String {
    Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(now.addingTimeInterval(-seconds))
}

@Suite struct RelativeTimeTests {
    @Test("counts in the largest whole unit, like the desktop")
    func largestWholeUnit() {
        #expect(RelativeTime(since: ago(30), now: now) == .now)
        #expect(RelativeTime(since: ago(5 * 60), now: now) == .minutes(5))
        #expect(RelativeTime(since: ago(3 * 3_600 + 59 * 60), now: now) == .hours(3))
        #expect(RelativeTime(since: ago(2 * day), now: now) == .days(2))
        #expect(RelativeTime(since: ago(15 * day), now: now) == .weeks(2))
        #expect(RelativeTime(since: ago(65 * day), now: now) == .months(2))
        #expect(RelativeTime(since: ago(800 * day), now: now) == .years(2))
    }

    @Test("treats a time slightly in the future as now")
    func futureIsNow() {
        #expect(RelativeTime(since: ago(-5), now: now) == .now)
    }
}
