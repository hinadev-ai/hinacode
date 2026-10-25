import HinaCodeKit

/// A `Caller` that records each call and leaves it pending until the test resolves or rejects it, like `fakeCall` in
/// `apps/mobile/src/stores/testing.ts`.
@MainActor
final class FakeCaller: Caller {
    @MainActor
    struct PendingCall {
        let method: String
        let payload: any Sendable
        let server: String?
        fileprivate let settle: @MainActor (Result<any Sendable, any Error>) -> Void

        func resolve(_ value: any Sendable) {
            settle(.success(value))
        }

        func reject(_ error: any Error) {
            settle(.failure(error))
        }
    }

    var calls: [PendingCall] = []
    /// Holds every continuation, so a call a test drops from `calls` stays pending like an unsettled promise instead of
    /// being reported as leaked.
    private var everyCall: [PendingCall] = []

    func call<Request, Response>(_ method: Method<Request, Response>, _ payload: Request, server: String?) async throws
        -> Response
    {
        try await withCheckedThrowingContinuation { continuation in
            let pending = PendingCall(method: method.name, payload: payload, server: server) { result in
                switch result {
                case .success(let value):
                    guard let response = value as? Response else {
                        fatalError("\(method.name) answers \(Response.self), not \(type(of: value))")
                    }
                    continuation.resume(returning: response)
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }
            calls.append(pending)
            everyCall.append(pending)
        }
    }

    /// The pending calls to `method`, oldest first.
    func requests(_ method: String) -> [PendingCall] {
        calls.filter { $0.method == method }
    }

    /// Lets every task that a resolved call or a store unblocked run until it waits again.
    func flush() async {
        for _ in 0..<20 { await Task.yield() }
    }
}
