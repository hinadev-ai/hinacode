import Foundation

/// A scheduled action. Cancelling one that already ran does nothing.
@MainActor
public final class TimerHandle {
    private var task: Task<Void, Never>?
    private let onCancel: (() -> Void)?

    init(task: Task<Void, Never>) {
        self.task = task
        onCancel = nil
    }

    public init(onCancel: @escaping () -> Void) {
        task = nil
        self.onCancel = onCancel
    }

    public func cancel() {
        task?.cancel()
        task = nil
        onCancel?()
    }
}

/// `setTimeout` and `setInterval` for the main-actor ports of the JavaScript clients, so their tests can drive a
/// manual clock instead of sleeping.
@MainActor
public protocol Timers: AnyObject {
    /// Time since an arbitrary origin, which only moves forward.
    var now: Duration { get }
    @discardableResult func after(_ delay: Duration, _ action: @escaping @MainActor () -> Void) -> TimerHandle
    @discardableResult func every(_ interval: Duration, _ action: @escaping @MainActor () -> Void) -> TimerHandle
}

/// Real time, on the continuous clock, which keeps counting while the device sleeps.
@MainActor
public final class SystemTimers: Timers {
    public static let shared = SystemTimers()
    private let origin = ContinuousClock.now

    public init() {}

    public var now: Duration { ContinuousClock.now - origin }

    public func after(_ delay: Duration, _ action: @escaping @MainActor () -> Void) -> TimerHandle {
        TimerHandle(
            task: Task { @MainActor in
                try? await Task.sleep(for: delay)
                if !Task.isCancelled { action() }
            })
    }

    public func every(_ interval: Duration, _ action: @escaping @MainActor () -> Void) -> TimerHandle {
        TimerHandle(
            task: Task { @MainActor in
                while !Task.isCancelled {
                    try? await Task.sleep(for: interval)
                    if !Task.isCancelled { action() }
                }
            })
    }
}
