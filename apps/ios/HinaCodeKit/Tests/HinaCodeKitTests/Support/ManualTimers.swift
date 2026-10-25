import HinaCodeKit

/// Timers that only fire when a test advances the clock, in due order, like fake timers in vitest.
@MainActor
final class ManualTimers: Timers {
    private struct Entry {
        let id: Int
        var due: Duration
        let interval: Duration?
        let action: @MainActor () -> Void
    }

    private(set) var now: Duration = .zero
    private var entries: [Entry] = []
    private var nextId = 0

    func after(_ delay: Duration, _ action: @escaping @MainActor () -> Void) -> TimerHandle {
        schedule(due: now + max(delay, .zero), interval: nil, action)
    }

    func every(_ interval: Duration, _ action: @escaping @MainActor () -> Void) -> TimerHandle {
        schedule(due: now + interval, interval: interval, action)
    }

    /// Moves the clock forward, firing every timer that comes due on the way, including ones they schedule.
    func advance(by duration: Duration) {
        let end = now + duration
        while let index = entries.indices.filter({ entries[$0].due <= end }).min(by: { order(entries[$0], entries[$1]) }
        ) {
            var entry = entries[index]
            now = entry.due
            if let interval = entry.interval {
                entry.due += interval
                entries[index] = entry
            } else {
                entries.remove(at: index)
            }
            entry.action()
        }
        now = end
    }

    /// How many timers are waiting.
    var pending: Int { entries.count }

    private func order(_ a: Entry, _ b: Entry) -> Bool {
        a.due == b.due ? a.id < b.id : a.due < b.due
    }

    private func schedule(due: Duration, interval: Duration?, _ action: @escaping @MainActor () -> Void) -> TimerHandle
    {
        nextId += 1
        let id = nextId
        entries.append(Entry(id: id, due: due, interval: interval, action: action))
        return TimerHandle { [weak self] in self?.entries.removeAll { $0.id == id } }
    }
}
