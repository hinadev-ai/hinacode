import Foundation

/// Why a call failed: the tag of the desktop handler's error, or `Offline`, `Timeout` or `Unauthorized`.
public struct RpcError: Error, Equatable, Sendable, LocalizedError {
    public let tag: String
    public let message: String

    public init(_ tag: String, _ message: String) {
        self.tag = tag
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// Sends one method to the desktop that should run it. The server hub in production, a fake in store tests.
@MainActor
public protocol Caller: AnyObject {
    /// `server` names the server for a method routed `.named`; nil picks the first connected one.
    func call<Request, Response>(_ method: Method<Request, Response>, _ payload: Request, server: String?) async throws
        -> Response
}

extension Caller {
    public func call<Request, Response>(_ method: Method<Request, Response>, _ payload: Request) async throws
        -> Response
    {
        try await call(method, payload, server: nil)
    }

    public func call<Response>(_ method: Method<NoPayload, Response>, server: String? = nil) async throws -> Response {
        try await call(method, NoPayload(), server: server)
    }
}
