import Foundation

public enum TransportStatus: Sendable {
    case connecting, connected, offline, unauthorized
}

/// One phone-to-desktop link, a port of `apps/mobile/src/lib/transport.ts`. It races the dial plan, proves the token,
/// queues calls while offline and resends them once the link is back, for up to a minute offline in total.
@MainActor
public final class Transport {
    nonisolated static let closeUnauthorized = 4001
    nonisolated static let closeTokenRotated = 4002
    nonisolated static let connectTimeout: Duration = .seconds(10)
    nonisolated static let pingInterval: Duration = .seconds(10)
    nonisolated static let idleTimeout: Duration = .seconds(25)
    nonisolated static let probeTimeout: Duration = .seconds(5)
    nonisolated static let offlineLimit: Duration = .seconds(60)
    private nonisolated static let minRetryMilliseconds = 500.0
    private nonisolated static let maxRetryMilliseconds = 10_000.0
    private nonisolated static let jitter = 0.3

    nonisolated static let notSentMessage = "Not sent. The desktop was unreachable for a minute."
    nonisolated static let mayHaveRunMessage =
        "The desktop was unreachable for a minute. The action may still have run."
    nonisolated static let lostReplyMessage =
        "The connection dropped before the desktop answered. The action may still have run."

    private final class PendingCall {
        let id: Int
        let method: String
        let payload: Data?
        let key: String?
        var sent = false
        var unsafeToResend = false
        var priorOffline: Duration = .zero
        var offlineSince: Duration?
        let continuation: CheckedContinuation<Data, any Error>

        init(id: Int, method: String, payload: Data?, key: String?, continuation: CheckedContinuation<Data, any Error>)
        {
            self.id = id
            self.method = method
            self.payload = payload
            self.key = key
            self.continuation = continuation
        }
    }

    /// What a round dials: the whole plan, or one route alone. A relay round follows a direct address that refused
    /// the token, and its link checks no direct address. A direct round follows a direct check that answered.
    private enum Round: Equatable {
        case both
        case only(Dial.Route)
    }

    /// What the current socket was sent: the token itself, or a proof the server's `ready` must answer.
    private enum SentAuth {
        case token
        case proof(expecting: String)
    }

    private let token: String
    private let onStatus: (TransportStatus, String?) -> Void
    private let onReady: (Set<String>, ServerIdentity?, String?) -> Void
    private let onEvent: (PushEvent) -> Void
    private let createSocket: (URL) -> SocketLike
    private let timers: Timers
    private let random: () -> Double
    private let newKey: () -> String

    private var socket: SocketLike?
    private var status: TransportStatus = .offline
    private var features: Set<String> = []
    private var attempt = 0
    private var nextCallId = 1
    private var foreground = true
    private var stopped = false
    private var route: Dial.Route?
    private var sentAuth: SentAuth?
    private var round: Round = .both
    private var cancelRace: (() -> Void)?
    private var cancelCheck: (() -> Void)?
    private var pending: [Int: PendingCall] = [:]
    private var retryTimer: TimerHandle?
    private var connectTimer: TimerHandle?
    private var challengeTimer: TimerHandle?
    private var idleTimer: TimerHandle?
    private var pingTimer: TimerHandle?
    private var offlineTimer: TimerHandle?
    private var checkTimer: TimerHandle?
    private var dials: [Dial]

    /// - Parameters:
    ///   - dials: What to dial in each round, from `PairingTarget.dialPlan`. Never empty.
    ///   - onReady: Called on every handshake with the features this desktop understands, which HinaCode it is when
    ///     it says, and its relay hostname, nil when it has none.
    public init(
        dials: [Dial],
        token: String,
        onStatus: @escaping (TransportStatus, String?) -> Void,
        onReady: @escaping (Set<String>, ServerIdentity?, String?) -> Void,
        onEvent: @escaping (PushEvent) -> Void,
        createSocket: @escaping (URL) -> SocketLike = { URLSessionSocket(url: $0) },
        timers: Timers = SystemTimers.shared,
        random: @escaping () -> Double = { Double.random(in: 0..<1) },
        newKey: @escaping () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.dials = dials
        self.token = token
        self.onStatus = onStatus
        self.onReady = onReady
        self.onEvent = onEvent
        self.createSocket = createSocket
        self.timers = timers
        self.random = random
        self.newKey = newKey
    }

    public func start() {
        open()
    }

    /// Closes for good, failing every pending call.
    public func stop() {
        stopped = true
        dropSocket()
        retryTimer?.cancel()
        offlineTimer?.cancel()
        failAll(RpcError("Offline", "Disconnected from the desktop."))
    }

    /// Sends `payload` once it can, and returns the desktop's whole result frame, for `ResultEnvelope` to decode.
    /// - Parameters:
    ///   - payload: The JSON-encoded payload, nil for a method that takes nothing.
    ///   - mutation: Whether the method changes state on the desktop, so a retry must carry a call key.
    /// - Throws: `RpcError` tagged `Offline`, `Timeout` or `Unauthorized` when the desktop never answered.
    public func call(_ method: String, payload: Data?, mutation: Bool) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            if stopped || status == .unauthorized {
                continuation.resume(throwing: RpcError("Offline", "Not connected to the desktop."))
                return
            }
            let call = PendingCall(
                id: nextCallId, method: method, payload: payload, key: mutation ? newKey() : nil,
                continuation: continuation)
            nextCallId += 1
            pending[call.id] = call
            if status == .connected {
                sendCall(call)
            } else {
                call.offlineSince = timers.now
                expireOfflineCalls()
            }
        }
    }

    /// The network changed: the old TCP connection is likely dead even if it looks open, so start over now.
    public func networkChanged() {
        if stopped || status == .unauthorized { return }
        redial()
    }

    /// The app moved to or from the foreground. Timers do not run reliably in the background, so they stop.
    public func setForeground(_ foreground: Bool) {
        if self.foreground == foreground { return }
        self.foreground = foreground
        if !foreground {
            stopHeartbeat()
            stopDirectChecks()
            return
        }
        if stopped || status == .unauthorized { return }
        if status == .connected {
            if checksDirect() {
                checkDirect()
                startDirectChecks()
            }
            if !features.contains("heartbeat") { return }
            ping()
            startPings()
            closeIfSilent(for: Self.probeTimeout)
        } else if status == .offline {
            reconnectNow()
        }
    }

    /// Dials `dials` from the next round on, keeping the current socket and every pending call.
    public func setDials(_ dials: [Dial]) {
        self.dials = dials
    }

    /// Skips the remaining backoff.
    public func reconnectNow() {
        guard status == .offline, let retryTimer else { return }
        retryTimer.cancel()
        self.retryTimer = nil
        open()
    }

    /// Opens a socket for each of `dials` after its delay and hands the first one to open to `onOpen`. Every other
    /// socket closes without a frame sent, so only the winner ever sees the token. `onFail` runs when every socket
    /// closed before one opened. Returns a function that cancels the race and closes what it opened.
    private func race(
        _ dials: [Dial], onOpen: @escaping (SocketLike, Dial) -> Void, onFail: @escaping () -> Void
    ) -> () -> Void {
        let createSocket = createSocket
        let timers = timers
        var delayed: [TimerHandle] = []
        var live: [SocketLike] = []
        var started = 0
        var done = false
        func cancel() {
            done = true
            for timer in delayed { timer.cancel() }
            let sockets = live
            live.removeAll()
            for ws in sockets { ws.close() }
        }
        func start(_ dial: Dial) {
            started += 1
            let ws = createSocket(dial.url)
            live.append(ws)
            ws.onOpen = { [weak ws] in
                guard let ws else { return }
                if done { return ws.close() }
                live.removeAll { $0 === ws }
                cancel()
                onOpen(ws, dial)
            }
            ws.onClose = { [weak ws] _ in
                live.removeAll { $0 === ws }
                if done || started < dials.count || !live.isEmpty { return }
                cancel()
                onFail()
            }
        }
        for dial in dials {
            if dial.delay == .zero {
                start(dial)
            } else {
                delayed.append(timers.after(dial.delay) { if !done { start(dial) } })
            }
        }
        return cancel
    }

    private func open(_ round: Round = .both) {
        if stopped { return }
        retryTimer = nil
        setStatus(.connecting, nil)
        self.round = round
        connectTimer = timers.after(Self.connectTimeout) { [weak self] in
            guard let self else { return }
            if socket == nil { noneOpened() } else { onLinkLost() }
        }
        let dials =
            switch round {
            case .both: self.dials
            case .only(let route):
                self.dials.filter { $0.route == route }.map { Dial(url: $0.url, route: $0.route, delay: .zero) }
            }
        cancelRace = race(
            dials, onOpen: { [weak self] ws, dial in self?.adopt(ws, route: dial.route) },
            onFail: { [weak self] in self?.noneOpened() })
    }

    /// The direct address a check found is gone again, so the relay may answer instead, without waiting.
    private func noneOpened() {
        if round != .only(.direct) { return onLinkLost() }
        dropSocket()
        open(.both)
    }

    private func adopt(_ ws: SocketLike, route: Dial.Route) {
        cancelRace = nil
        socket = ws
        self.route = route
        // A server that predates the challenge only gets the token where a stranger cannot be listening: over the
        // relay, or on a pairing without one. A direct address of a pairing with a relay always runs a server that
        // challenges.
        challengeTimer = timers.after(Remote.challengeWait) { [weak self] in
            guard let self else { return }
            if route == .relay || !hasRelay() {
                sentAuth = .token
                sendFrame(.token(token))
            } else {
                closed(code: Self.closeUnauthorized, route: route)
            }
        }
        ws.onMessage = { [weak self, weak ws] frame in
            guard let self, let ws, socket === ws else { return }
            receive(frame, route: route)
        }
        ws.onClose = { [weak self, weak ws] code in
            guard let self, let ws, socket === ws else { return }
            closed(code: code, route: route)
        }
    }

    private func closed(code: Int, route: Dial.Route) {
        // Away from home, a stranger's HinaCode can answer at the same LAN address and refuse a token the machine
        // still accepts, so only the relay, whose hostname is the machine's own, gets the last word.
        if code == Self.closeUnauthorized && route == .direct && status == .connecting && hasRelay() {
            dropSocket()
            open(.only(.relay))
            return
        }
        if code == Self.closeUnauthorized || code == Self.closeTokenRotated {
            dropSocket()
            unauthorized(
                code == Self.closeTokenRotated
                    ? "The token was rotated on the desktop. Pair again with the new QR code."
                    : "The desktop refused this token. Pair again from Settings > Remote.")
            return
        }
        onLinkLost()
    }

    private func hasRelay() -> Bool {
        dials.contains { $0.route == .relay }
    }

    private func answerChallenge(_ serverNonce: String) {
        if sentAuth != nil { return }
        challengeTimer?.cancel()
        let clientNonce = PairingProof.newNonce()
        sentAuth = .proof(
            expecting: PairingProof.server(token: token, clientNonce: clientNonce, serverNonce: serverNonce))
        sendFrame(
            .proof(
                nonce: clientNonce,
                proof: PairingProof.client(token: token, serverNonce: serverNonce, clientNonce: clientNonce)))
    }

    /// Whether a `ready` came from a server that holds the token. One that only received the token itself cannot
    /// say.
    private func provesToken(_ proof: String?) -> Bool {
        switch sentAuth {
        case .token: true
        case .proof(let expected): proof == expected
        case nil: false
        }
    }

    private func receive(_ frame: IncomingFrame, route: Dial.Route) {
        if status == .connected { closeIfSilent(for: Self.idleTimeout) }
        switch frame {
        case .challenge(let nonce):
            answerChallenge(nonce)
        case .ready(let ready):
            if !provesToken(ready.proof) { return closed(code: Self.closeUnauthorized, route: route) }
            self.ready(
                version: ready.version, features: ready.features, environment: ready.environment, relay: ready.relay)
        case .result(let id, let frame):
            let call = pending.removeValue(forKey: id)
            call?.continuation.resume(returning: frame)
            if call != nil { expireOfflineCalls() }
        case .event(let event):
            onEvent(event)
        case .pong, .unreadable:
            break
        }
    }

    private func ready(version: Int, features: [String], environment: ServerIdentity?, relay: String?) {
        connectTimer?.cancel()
        if version != Remote.protocolVersion {
            dropSocket()
            unauthorized(
                "The desktop speaks remote protocol \(version), this app speaks \(Remote.protocolVersion). Update the older one."
            )
            return
        }
        expireOfflineCalls()
        offlineTimer?.cancel()
        attempt = 0
        self.features = Set(features)
        setStatus(.connected, nil)
        let now = timers.now
        for call in pendingInOrder {
            if let offlineSince = call.offlineSince { call.priorOffline += now - offlineSince }
            call.offlineSince = nil
            sendCall(call)
        }
        if self.features.contains("heartbeat") && foreground {
            startPings()
            closeIfSilent(for: Self.idleTimeout)
        }
        if checksDirect() && foreground { startDirectChecks() }
        onReady(self.features, environment, relay)
    }

    private func sendCall(_ call: PendingCall) {
        let keyed = call.key != nil && features.contains("call-keys")
        call.sent = true
        if call.key != nil && !keyed { call.unsafeToResend = true }
        sendFrame(.call(id: call.id, method: call.method, payload: call.payload, key: keyed ? call.key : nil))
    }

    private func sendFrame(_ frame: ClientFrame) {
        socket?.send(frame.text)
    }

    private func ping() {
        sendFrame(.ping(at: Int(timers.now / .milliseconds(1))))
    }

    private func startPings() {
        pingTimer?.cancel()
        pingTimer = timers.every(Self.pingInterval) { [weak self] in self?.ping() }
    }

    private func closeIfSilent(for duration: Duration) {
        if !features.contains("heartbeat") || !foreground { return }
        idleTimer?.cancel()
        let ws = socket
        idleTimer = timers.after(duration) { [weak self] in
            guard let self, socket === ws else { return }
            onLinkLost()
        }
    }

    private func stopHeartbeat() {
        pingTimer?.cancel()
        idleTimer?.cancel()
        pingTimer = nil
        idleTimer = nil
    }

    private func checksDirect() -> Bool {
        route == .relay && round == .both
    }

    private func startDirectChecks() {
        checkTimer?.cancel()
        checkTimer = timers.every(Remote.directCheckInterval) { [weak self] in self?.checkDirect() }
    }

    private func stopDirectChecks() {
        checkTimer?.cancel()
        checkTimer = nil
        cancelCheck?()
    }

    /// Opens the direct addresses without the token. When one answers, the relay link gives way to a direct round.
    private func checkDirect() {
        let direct = dials.filter { $0.route == .direct }
        if direct.isEmpty { return }
        cancelCheck?()
        let cancelRace = race(
            direct,
            onOpen: { [weak self] ws, _ in
                ws.close()
                self?.redial(.only(.direct))
            },
            onFail: { [weak self] in self?.cancelCheck?() })
        let timeout = timers.after(Remote.directCheckTimeout) { [weak self] in self?.cancelCheck?() }
        cancelCheck = { [weak self] in
            timeout.cancel()
            cancelRace()
            self?.cancelCheck = nil
        }
    }

    private func redial(_ round: Round = .both) {
        onLinkLost()
        attempt = 0
        retryTimer?.cancel()
        open(round)
    }

    private func onLinkLost() {
        dropSocket()
        let now = timers.now
        for call in pendingInOrder {
            if call.unsafeToResend {
                pending[call.id] = nil
                call.continuation.resume(throwing: RpcError("Offline", Self.lostReplyMessage))
            } else if call.offlineSince == nil {
                call.offlineSince = now
            }
        }
        expireOfflineCalls()
        setStatus(.offline, nil)
        let base = min(Self.maxRetryMilliseconds, Self.minRetryMilliseconds * pow(2, Double(attempt)))
        attempt += 1
        retryTimer?.cancel()
        retryTimer = timers.after(.milliseconds(base * (1 + (random() * 2 - 1) * Self.jitter))) { [weak self] in
            self?.open()
        }
    }

    private func dropSocket() {
        connectTimer?.cancel()
        challengeTimer?.cancel()
        sentAuth = nil
        stopHeartbeat()
        stopDirectChecks()
        cancelRace?()
        cancelRace = nil
        let ws = socket
        socket = nil
        route = nil
        ws?.close()
    }

    private func unauthorized(_ error: String) {
        retryTimer?.cancel()
        offlineTimer?.cancel()
        retryTimer = nil
        setStatus(.unauthorized, error)
        failAll(RpcError("Unauthorized", error))
    }

    private func expireOfflineCalls() {
        offlineTimer?.cancel()
        let now = timers.now
        var next: Duration?
        for call in pendingInOrder {
            guard let offlineSince = call.offlineSince else { continue }
            let remaining = Self.offlineLimit - call.priorOffline - (now - offlineSince)
            if remaining > .zero {
                next = min(next ?? remaining, remaining)
                continue
            }
            pending[call.id] = nil
            let mayHaveRun = call.sent && call.key != nil
            call.continuation.resume(
                throwing: RpcError("Timeout", mayHaveRun ? Self.mayHaveRunMessage : Self.notSentMessage))
        }
        if let next { offlineTimer = timers.after(next) { [weak self] in self?.expireOfflineCalls() } }
    }

    private func failAll(_ error: RpcError) {
        let calls = pendingInOrder
        pending.removeAll()
        for call in calls { call.continuation.resume(throwing: error) }
    }

    private func setStatus(_ status: TransportStatus, _ error: String?) {
        self.status = status
        onStatus(status, error)
    }

    /// The pending calls in the order they were made, as a JavaScript `Map` iterates them.
    private var pendingInOrder: [PendingCall] {
        pending.values.sorted { $0.id < $1.id }
    }
}
