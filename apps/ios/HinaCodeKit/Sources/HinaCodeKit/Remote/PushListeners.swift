import Foundation

/// Fans every push out to the views that listen for one kind, such as a terminal waiting for its output.
@MainActor
public final class PushListeners {
    private var handlers: [Int: (PushEvent) -> Void] = [:]
    private var nextId = 0

    public init() {}

    /// Calls `handler` with every push until the subscription is cancelled or released.
    public func listen(_ handler: @escaping (PushEvent) -> Void) -> PushSubscription {
        nextId += 1
        let id = nextId
        handlers[id] = handler
        return PushSubscription { [weak self] in self?.handlers[id] = nil }
    }

    public func send(_ push: PushEvent) {
        for handler in handlers.values { handler(push) }
    }
}

/// Stops its listener when cancelled or released.
@MainActor
public final class PushSubscription {
    private var stop: (() -> Void)?

    init(stop: @escaping () -> Void) {
        self.stop = stop
    }

    public func cancel() {
        stop?()
        stop = nil
    }

    isolated deinit {
        cancel()
    }
}
