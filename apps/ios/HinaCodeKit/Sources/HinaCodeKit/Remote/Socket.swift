import Foundation

/// The part of a WebSocket the transport uses. A socket fires `onOpen` at most once, then frames in order, and
/// `onClose` at most once, with the close code.
@MainActor
public protocol SocketLike: AnyObject {
    var onOpen: (() -> Void)? { get set }
    var onMessage: ((IncomingFrame) -> Void)? { get set }
    var onClose: ((Int) -> Void)? { get set }
    func send(_ text: String)
    func close()
}

/// A WebSocket over `URLSessionWebSocketTask` that decodes each text message off the main actor.
@MainActor
public final class URLSessionSocket: SocketLike {
    public var onOpen: (() -> Void)?
    public var onMessage: ((IncomingFrame) -> Void)?
    public var onClose: ((Int) -> Void)?

    private let task: URLSessionWebSocketTask
    private var closing = false

    public init(url: URL) {
        task = SocketSession.shared.session.webSocketTask(with: url)
        // Above the listener's slow-consumer limit, so the largest answer it sends still arrives.
        task.maximumMessageSize = 2 * Remote.slowConsumerBytes
        SocketSession.shared.sockets[task.taskIdentifier] = WeakSocket(socket: self)
        task.resume()
        Task.detached { [weak self, task] in
            while let message = try? await task.receive() {
                guard case .string(let text) = message else { continue }
                let frame = IncomingFrame(text: text)
                await self?.deliver(frame)
            }
        }
    }

    deinit {
        task.cancel()
    }

    public func send(_ text: String) {
        task.send(.string(text)) { _ in }
    }

    /// Like a browser's `WebSocket.close()`: nothing arrives after it but `onClose`.
    public func close() {
        closing = true
        task.cancel(with: .normalClosure, reason: nil)
    }

    private func deliver(_ frame: IncomingFrame) {
        if !closing { onMessage?(frame) }
    }

    fileprivate func opened() {
        if !closing { onOpen?() }
    }

    fileprivate func finish(code: Int) {
        onClose?(code)
    }
}

private struct WeakSocket {
    weak var socket: URLSessionSocket?
}

/// One session for every socket. Its delegate runs on the main queue, so open and close reach a socket in the order
/// URLSession reports them, ahead of the frames that follow.
@MainActor
private final class SocketSession: NSObject, URLSessionWebSocketDelegate {
    static let shared = SocketSession()

    lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    var sockets: [Int: WeakSocket] = [:]

    nonisolated func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?
    ) {
        let id = webSocketTask.taskIdentifier
        MainActor.assumeIsolated { sockets[id]?.socket?.opened() }
    }

    nonisolated func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
        let id = webSocketTask.taskIdentifier
        let code = closeCode.rawValue
        MainActor.assumeIsolated { finish(id, code: code) }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        let id = task.taskIdentifier
        let code = (task as? URLSessionWebSocketTask)?.closeCode.rawValue ?? 0
        MainActor.assumeIsolated { finish(id, code: code) }
    }

    /// Forgets the socket on its first close event, so `onClose` fires once.
    private func finish(_ id: Int, code: Int) {
        // A connection that failed or dropped without a close frame has no code, which browsers report as 1006.
        sockets.removeValue(forKey: id)?.socket?.finish(code: code == 0 ? 1006 : code)
    }
}
