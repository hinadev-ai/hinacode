/// A value read through the desktop, such as a pull request GitHub answered. A refresh keeps the last value until the
/// new one lands. `at` is when the read settled, on the store's `Timers` clock.
public enum RemoteValue<Value> {
    case loading
    case ready(Value, at: Duration)
    /// `tag` is the `RpcError` tag, nil for any other failure. `SchemaError` means the desktop predates the method.
    case error(message: String, tag: String?, at: Duration)

    public var value: Value? {
        switch self {
        case .ready(let value, _): value
        case .loading, .error: nil
        }
    }

    static func failure(_ error: any Error, at: Duration) -> Self {
        .error(message: error.localizedDescription, tag: (error as? RpcError)?.tag, at: at)
    }

    /// Whether a read can be skipped: one is in flight, or the last settled less than `maxAge` ago. A failure counts
    /// too, so it is retried after the same interval.
    func isFresh(now: Duration, maxAge: Duration) -> Bool {
        switch self {
        case .loading: true
        case .ready(_, let at), .error(_, _, let at): now - at < maxAge
        }
    }

    func map<Other>(_ transform: (Value) -> Other) -> RemoteValue<Other> {
        switch self {
        case .loading: .loading
        case .ready(let value, let at): .ready(transform(value), at: at)
        case .error(let message, let tag, let at): .error(message: message, tag: tag, at: at)
        }
    }
}

extension RemoteValue: Equatable where Value: Equatable {}
extension RemoteValue: Sendable where Value: Sendable {}
