import Foundation
import Testing

@testable import HinaCodeKit

private let token = "secret"
private let allFeatures = FakeSocket.allFeatures
private let mutations: Set<String> = ["threads.send", "approvals.respond"]

private let tailscale = "ws://100.64.0.2:47821/remote"
private let lan = "ws://192.168.1.5:47821/remote"
private let relayURL = "wss://mac.example.com/remote"

private func direct(_ url: String) -> Dial { Dial(url: URL(string: url)!, route: .direct, delay: .zero) }
private func relay(_ url: String) -> Dial { Dial(url: URL(string: url)!, route: .relay, delay: Remote.relayDelay) }

/// Fake timers whose wall clock can also jump without firing anything, like `vi.setSystemTime`.
@MainActor
private final class TestClock: Timers {
    private let manual = ManualTimers()
    private var skew: Duration = .zero

    var now: Duration { manual.now + skew }

    func after(_ delay: Duration, _ action: @escaping @MainActor () -> Void) -> TimerHandle {
        manual.after(delay, action)
    }

    func every(_ interval: Duration, _ action: @escaping @MainActor () -> Void) -> TimerHandle {
        manual.every(interval, action)
    }

    func advance(_ milliseconds: Int) { manual.advance(by: .milliseconds(milliseconds)) }

    func jump(_ milliseconds: Int) { skew += .milliseconds(milliseconds) }
}

/// A call in flight, started at once so it is queued or sent before the next line runs.
@MainActor
private final class TrackedCall {
    private var outcome: Result<Data, RpcError>?

    init(_ call: @escaping @MainActor () async throws -> Data) {
        Task.immediate {
            do {
                self.outcome = .success(try await call())
            } catch {
                self.outcome = .failure(error as? RpcError ?? RpcError("NotRpcError", "\(error)"))
            }
        }
    }

    /// The outcome once a resumed call has had its turn on the main actor. A bounded number of yields, rather than
    /// awaiting the task, so a call that never settles fails the test instead of hanging it.
    private func settled() async -> Result<Data, RpcError>? {
        for _ in 0..<100 where outcome == nil { await Task.yield() }
        return outcome
    }

    var isPending: Bool {
        get async { await settled() == nil }
    }

    var succeeded: Bool {
        get async { if case .success = await settled() { true } else { false } }
    }

    var error: RpcError? {
        get async {
            guard case .failure(let error) = await settled() else { return nil }
            return error
        }
    }

    func answer<Response: Decodable>(_ type: Response.Type) async throws -> Response {
        let frame = try #require(try await settled()?.get())
        return try JSONDecoder().decode(ResultEnvelope<Response>.self, from: frame).result.get()
    }
}

@MainActor
private final class Harness {
    let clock = TestClock()
    private(set) var sockets: [FakeSocket] = []
    private(set) var statuses: [TransportStatus] = []
    private(set) var readyCount = 0
    private var keys = 0
    private(set) var transport: Transport!

    init(_ dials: [Dial] = [direct("ws://desktop/remote")], random: Double = 0.5) {
        let hasRelay = dials.contains { $0.route == .relay }
        let directURLs = Set(dials.filter { $0.route == .direct }.map(\.url))
        transport = Transport(
            dials: dials,
            token: token,
            onStatus: { [unowned self] status, _ in statuses.append(status) },
            onReady: { [unowned self] _, _, _ in readyCount += 1 },
            onEvent: { _ in },
            createSocket: { [unowned self] url in
                let socket = FakeSocket(url: url, token: token, mustNotSeeToken: hasRelay && directURLs.contains(url))
                sockets.append(socket)
                return socket
            },
            timers: clock,
            random: { random },
            newKey: { [unowned self] in
                keys += 1
                return "key-\(keys)"
            })
        transport.start()
    }

    var latest: FakeSocket { sockets.last! }

    func socket(at url: String) -> FakeSocket { sockets.last { $0.url == url }! }

    var urls: [String] { sockets.map(\.url) }

    func handshake(_ features: [String] = allFeatures) {
        latest.open()
        latest.challenge()
        latest.ready(features)
    }

    func call(_ method: String, _ payload: String? = nil) -> TrackedCall {
        let transport = transport!
        return TrackedCall {
            try await transport.call(
                method, payload: payload.map { Data($0.utf8) }, mutation: mutations.contains(method))
        }
    }

    func advance(_ milliseconds: Int) { clock.advance(milliseconds) }

    func connectOverRelay() {
        advance(relayDelay)
        socket(at: relayURL).open()
        socket(at: relayURL).challenge()
        socket(at: relayURL).ready(["call-keys"])
    }
}

private func milliseconds(_ duration: Duration) -> Int { Int(duration / .milliseconds(1)) }

private let relayDelay = milliseconds(Remote.relayDelay)
private let directCheckInterval = milliseconds(Remote.directCheckInterval)
private let directCheckTimeout = milliseconds(Remote.directCheckTimeout)
private let challengeWait = milliseconds(Remote.challengeWait)
private let connectTimeout = milliseconds(Transport.connectTimeout)

@MainActor
@Suite("Transport", .timeLimit(.minutes(1)))
struct TransportTests {
    @Test("answers the challenge with a proof instead of the token and connects on a ready that proves it back")
    func proves() throws {
        let h = Harness()
        #expect(h.statuses == [.connecting])
        h.latest.open()
        #expect(h.latest.sent == [])
        h.latest.challenge("server-nonce")
        let auth = try #require(h.latest.sent.first)
        #expect(auth.isProof)
        #expect(auth.proof == PairingProof.client(token: token, serverNonce: "server-nonce", clientNonce: auth.nonce!))
        #expect(!h.latest.texts.joined().contains(token))
        #expect(h.statuses.last == .connecting)
        h.latest.ready()
        #expect(h.statuses.last == .connected)
        #expect(h.readyCount == 1)
    }

    @Test("queues a call made while connecting and sends it after ready")
    func queues() async throws {
        let h = Harness()
        let result = h.call("threads.list")
        #expect(h.latest.calls() == [])
        h.handshake()
        #expect(h.latest.calls() == [.call(1, "threads.list")])
        h.latest.result(1, #"["thread"]"#)
        #expect(try await result.answer([String].self) == ["thread"])
    }

    @Test("retries a mutation after a drop with the same key, in order")
    func retriesWithKeys() async throws {
        let h = Harness()
        h.handshake()
        let send = h.call("threads.send", #"{"prompt":"hi"}"#)
        let read = h.call("threads.list")
        let allow = h.call("approvals.respond", #"{"decision":"allow"}"#)
        #expect(h.latest.calls().map(\.key) == ["key-1", nil, "key-2"])

        h.latest.drop()
        #expect(h.statuses.last == .offline)
        h.advance(500)
        h.handshake()

        #expect(
            h.latest.calls() == [
                .call(1, "threads.send", payload: .object(["prompt": .string("hi")]), key: "key-1"),
                .call(2, "threads.list"),
                .call(3, "approvals.respond", payload: .object(["decision": .string("allow")]), key: "key-2"),
            ])
        h.latest.result(1)
        h.latest.result(2, "[]")
        h.latest.result(3)
        #expect(await send.succeeded)
        #expect(await read.succeeded)
        #expect(await allow.succeeded)
        #expect(try await read.answer([JSONValue].self) == [])
    }

    @Test("ignores a result from a socket it already dropped")
    func staleResult() async {
        let h = Harness()
        h.handshake()
        let send = h.call("threads.send", "{}")
        let old = h.latest
        old.drop()
        old.result(1, #""stale""#)
        #expect(await send.isPending)
    }

    @Test("fails an unsent call after 60 s offline in total, not counting time connected")
    func offlineBudget() async {
        let h = Harness()
        let send = h.call("threads.send", "{}")

        h.advance(9_000)
        h.latest.drop()
        h.advance(21_000)
        #expect(await send.isPending)
        h.handshake()
        h.advance(20_000)
        #expect(await send.isPending)
        h.latest.drop()
        h.advance(29_999)
        #expect(await send.isPending)
        h.advance(1)
        #expect(await send.error == RpcError("Timeout", Transport.mayHaveRunMessage))
    }

    @Test("says not sent when the call never left the phone")
    func notSent() async {
        let h = Harness()
        let send = h.call("threads.send", "{}")
        h.advance(60_000)
        #expect(await send.error == RpcError("Timeout", Transport.notSentMessage))
    }

    @Test("expires a call on ready when the clock jumped past the limit before its timer ran")
    func clockJump() async {
        let h = Harness()
        let send = h.call("threads.send", "{}")
        let read = h.call("threads.list")
        h.clock.jump(61_000)
        h.handshake()
        h.advance(0)
        #expect(h.latest.calls() == [])
        #expect(await send.error == RpcError("Timeout", Transport.notSentMessage))
        #expect(await read.error == RpcError("Timeout", Transport.notSentMessage))
    }

    @Test("counts earlier outages when a late ready arrives")
    func earlierOutages() async {
        let h = Harness()
        h.handshake()
        let send = h.call("threads.send", "{}")
        h.latest.drop()
        h.advance(400)
        h.clock.jump(30_000)
        h.advance(100)
        h.handshake()
        #expect(h.latest.calls().count == 1)

        h.latest.drop()
        h.advance(400)
        h.clock.jump(29_600)
        h.advance(100)
        let before = h.latest.calls().count
        h.handshake()
        h.advance(0)
        #expect(h.latest.calls().count == before)
        #expect(await send.error == RpcError("Timeout", Transport.mayHaveRunMessage))
    }

    @Test("still sends a call whose outage stayed under the limit")
    func underLimit() async throws {
        let h = Harness()
        let send = h.call("threads.send", "{}")
        h.clock.jump(59_000)
        h.handshake()
        #expect(h.latest.calls().count == 1)
        h.latest.result(1)
        #expect(try await send.answer(JSONValue.self) == .null)
    }

    @Test("never times out a call that waits on a live link")
    func liveLink() async throws {
        let h = Harness()
        h.handshake(["call-keys"])
        let clone = h.call("threads.send", "{}")
        h.advance(5 * 60_000)
        #expect(await clone.isPending)
        h.latest.result(1)
        #expect(try await clone.answer(JSONValue.self) == .null)
    }

    @Test("closes a socket that has not said ready within 10 s and retries")
    func connectTimeoutRetries() {
        let h = Harness()
        h.latest.open()
        h.advance(9_999)
        #expect(!h.latest.closed)
        h.advance(1)
        #expect(h.sockets[0].closed)
        #expect(h.statuses.last == .offline)
        h.advance(500)
        #expect(h.sockets.count == 2)
    }

    @Test("doubles from 0.5 s up to 10 s and resets after ready")
    func backoff() {
        let h = Harness()
        var delays: [Int] = []
        for _ in 0..<7 {
            let before = h.sockets.count
            h.latest.drop()
            var waited = 0
            while h.sockets.count == before {
                h.advance(100)
                waited += 100
            }
            delays.append(waited)
        }
        #expect(delays == [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000])

        h.handshake()
        h.latest.drop()
        h.advance(500)
        #expect(h.statuses.last == .connecting)
    }

    @Test("applies up to 30% jitter")
    func jitter() {
        let h = Harness(random: 0)
        h.latest.drop()
        h.advance(349)
        #expect(h.sockets.count == 1)
        h.advance(1)
        #expect(h.sockets.count == 2)
    }

    @Test("retries after close code", arguments: [4003, 4004, 4005, 4006, 1006])
    func retries(code: Int) {
        let h = Harness()
        h.latest.drop(code)
        h.advance(500)
        #expect(h.sockets.count == 2)
    }

    @Test(
        "stops after close code and fails pending calls",
        arguments: [Transport.closeUnauthorized, Transport.closeTokenRotated])
    func stops(code: Int) async {
        let h = Harness()
        let send = h.call("threads.send", "{}")
        h.latest.open()
        h.latest.challenge()
        h.latest.drop(code)
        h.advance(60_000)
        #expect(h.sockets.count == 1)
        #expect(h.statuses.last == .unauthorized)
        #expect(await send.error?.tag == "Unauthorized")
    }

    @Test("pings every 10 s and closes after exactly 25 s without a frame")
    func pings() {
        let h = Harness()
        h.handshake()
        h.advance(10_000)
        #expect(h.latest.pings().count == 1)
        h.advance(14_999)
        #expect(h.latest.pings().count == 2)
        #expect(!h.latest.closed)
        h.advance(1)
        #expect(h.sockets[0].closed)
        #expect(h.statuses.last == .offline)
    }

    @Test("counts any frame as alive, measuring 25 s from the last one")
    func anyFrameIsAlive() {
        let h = Harness()
        h.handshake()
        h.advance(20_000)
        h.latest.receive(#"{"type":"pong","at":0}"#)
        h.advance(24_999)
        #expect(!h.latest.closed)
        h.advance(1)
        #expect(h.latest.closed)
    }

    @Test("pauses in the background and probes for 5 s on return")
    func background() {
        let h = Harness()
        h.handshake()
        h.transport.setForeground(false)
        h.advance(120_000)
        #expect(!h.latest.closed)
        #expect(h.latest.pings().isEmpty)

        h.transport.setForeground(true)
        #expect(h.latest.pings().count == 1)
        h.advance(4_999)
        #expect(!h.latest.closed)
        h.advance(1)
        #expect(h.latest.closed)
    }

    @Test("keeps a socket whose probe is answered")
    func probeAnswered() {
        let h = Harness()
        h.handshake()
        h.transport.setForeground(false)
        h.transport.setForeground(true)
        h.latest.receive(#"{"type":"pong","at":0}"#)
        h.advance(10_000)
        #expect(!h.latest.closed)
    }

    @Test("replaces a socket that looks open when the network changes")
    func networkChangeReplaces() {
        let h = Harness()
        h.handshake()
        h.transport.networkChanged()
        #expect(h.sockets[0].closed)
        #expect(h.sockets.count == 2)
        #expect(h.statuses.last == .connecting)
    }

    @Test("skips the backoff when the network changes while offline")
    func networkChangeSkipsBackoff() {
        let h = Harness()
        for _ in 0..<5 {
            h.latest.drop()
            h.advance(10_000)
        }
        h.latest.drop()
        let before = h.sockets.count
        h.transport.networkChanged()
        #expect(h.sockets.count == before + 1)
    }

    @Test("skips the backoff when the app returns to the foreground offline")
    func foregroundSkipsBackoff() {
        let h = Harness()
        h.transport.setForeground(false)
        h.latest.drop()
        h.transport.setForeground(true)
        #expect(h.sockets.count == 2)
    }

    @Test("sends queued calls once over the new socket")
    func resendsOnce() async throws {
        let h = Harness()
        h.handshake()
        let send = h.call("threads.send", "{}")
        h.transport.networkChanged()
        h.handshake()
        #expect(h.sockets[0].calls().count == 1)
        #expect(h.latest.calls() == [.call(1, "threads.send", payload: .object([:]), key: "key-1")])
        h.latest.result(1)
        #expect(try await send.answer(JSONValue.self) == .null)
    }

    @Test("sends no pings or keys and never closes an idle link")
    func olderDesktopIdle() {
        let h = Harness()
        h.handshake([])
        _ = h.call("threads.list")
        h.advance(5 * 60_000)
        #expect(h.latest.pings().isEmpty)
        #expect(!h.latest.closed)

        h.transport.setForeground(false)
        h.transport.setForeground(true)
        #expect(h.latest.pings().isEmpty)
    }

    @Test("omits the key on a mutation and fails it on a drop instead of sending it twice")
    func olderDesktopMutation() async throws {
        let h = Harness()
        h.handshake([])
        let send = h.call("threads.send", #"{"prompt":"hi"}"#)
        let read = h.call("threads.list")
        #expect(
            h.latest.calls() == [
                .call(1, "threads.send", payload: .object(["prompt": .string("hi")])), .call(2, "threads.list"),
            ])

        h.latest.drop()
        h.advance(0)
        #expect(await send.error == RpcError("Offline", Transport.lostReplyMessage))

        h.advance(500)
        h.handshake([])
        #expect(h.latest.calls() == [.call(2, "threads.list")])
        h.latest.result(2, "[]")
        #expect(try await read.answer([JSONValue].self) == [])
    }

    @Test("still sends a mutation queued before it reached the old desktop")
    func olderDesktopQueued() async throws {
        let h = Harness()
        let send = h.call("threads.send", "{}")
        h.latest.drop()
        h.advance(500)
        h.handshake([])
        #expect(h.latest.calls() == [.call(1, "threads.send", payload: .object([:]))])
        h.latest.result(1)
        #expect(try await send.answer(JSONValue.self) == .null)
    }

    @Test("refuses a different protocol version without retrying")
    func protocolVersion() async {
        let h = Harness()
        let read = h.call("threads.list")
        h.latest.open()
        h.latest.challenge()
        h.latest.ready([], version: 2)
        h.advance(60_000)
        #expect(h.statuses.last == .unauthorized)
        #expect(h.sockets.count == 1)
        #expect(await read.error?.tag == "Unauthorized")
    }

    @Test("dials every direct address at once and the relay after its delay")
    func dialsPlan() {
        let h = Harness([direct(tailscale), direct(lan), relay(relayURL)])
        #expect(h.urls == [tailscale, lan])
        h.advance(relayDelay - 1)
        #expect(h.urls == [tailscale, lan])
        h.advance(1)
        #expect(h.urls == [tailscale, lan, relayURL])
    }

    @Test("answers only the first socket that opens and closes the rest unused")
    func firstOpenWins() {
        let h = Harness([direct(tailscale), direct(lan), relay(relayURL)])
        h.advance(relayDelay)
        h.socket(at: lan).open()
        h.socket(at: relayURL).open()
        h.socket(at: tailscale).open()
        h.socket(at: lan).challenge()
        #expect(h.socket(at: lan).sent.count == 1)
        #expect(h.socket(at: lan).sent.allSatisfy { $0.isProof })
        for url in [tailscale, relayURL] {
            #expect(h.socket(at: url).closed)
            #expect(h.socket(at: url).sent == [])
        }
        h.socket(at: lan).ready()
        #expect(h.statuses.last == .connected)
    }

    @Test("falls back to the relay when no direct address opens")
    func fallsBackToRelay() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.advance(relayDelay)
        h.socket(at: relayURL).open()
        h.socket(at: relayURL).challenge()
        #expect(h.socket(at: lan).closed)
        #expect(h.socket(at: lan).sent == [])
        #expect(h.socket(at: relayURL).sent.count == 1)
        #expect(h.socket(at: relayURL).sent.allSatisfy { $0.isProof })
    }

    @Test("waits for the relay when a direct address closes first")
    func waitsForRelay() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.socket(at: lan).drop()
        #expect(h.statuses.last == .connecting)
        h.advance(relayDelay)
        h.socket(at: relayURL).open()
        h.socket(at: relayURL).challenge()
        h.socket(at: relayURL).ready()
        #expect(h.statuses.last == .connected)
    }

    @Test("loses the link when nothing opens within the connect timeout, then backs off")
    func nothingOpens() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.advance(10_000)
        #expect(h.sockets.allSatisfy { $0.closed })
        #expect(h.statuses.last == .offline)
        h.advance(499)
        #expect(h.sockets.count == 2)
        h.advance(1)
        #expect(h.urls == [lan, relayURL, lan])
    }

    @Test("loses the link at once when every socket closed")
    func everySocketClosed() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.advance(relayDelay)
        h.socket(at: lan).drop()
        h.socket(at: relayURL).drop()
        #expect(h.statuses.last == .offline)
    }

    @Test("stops on a refused token instead of trying the other addresses")
    func refusedDirect() {
        let h = Harness([direct(tailscale), direct(lan)])
        h.socket(at: tailscale).open()
        h.socket(at: tailscale).challenge()
        h.socket(at: tailscale).drop(Transport.closeUnauthorized)
        h.advance(60_000)
        #expect(h.urls == [tailscale, lan])
        #expect(h.statuses.last == .unauthorized)
    }

    @Test("moves from the relay to a direct address once one answers, keeping pending calls")
    func movesToDirect() async throws {
        let h = Harness([direct(lan), relay(relayURL)])
        h.connectOverRelay()
        let read = h.call("threads.list")
        let before = h.sockets.count
        h.advance(directCheckInterval - 1)
        #expect(h.sockets.count == before)
        h.advance(1)
        let check = h.latest
        #expect(check.url == lan)

        check.open()
        #expect(check.closed)
        #expect(check.sent == [])
        #expect(h.socket(at: relayURL).closed)
        #expect(h.latest !== check)
        #expect(h.latest.url == lan)

        h.handshake(["call-keys"])
        #expect(h.latest.calls() == [.call(1, "threads.list")])
        h.latest.result(1, "[]")
        #expect(try await read.answer([JSONValue].self) == [])
    }

    @Test("stays on the relay when no direct address answers the check")
    func staysOnRelay() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.connectOverRelay()
        let relaySocket = h.socket(at: relayURL)
        h.advance(directCheckInterval + directCheckTimeout)
        #expect(h.latest.url == lan)
        #expect(h.latest.closed)
        #expect(!relaySocket.closed)
        #expect(h.statuses.last == .connected)

        h.advance(directCheckInterval - directCheckTimeout)
        #expect(h.sockets.filter { $0.url == lan }.count == 3)
    }

    @Test("checks no direct address while connected directly")
    func noCheckWhenDirect() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.handshake(["call-keys"])
        h.advance(3 * directCheckInterval)
        #expect(h.urls == [lan])
    }

    @Test("checks nothing in the background and checks at once on return")
    func checksOnReturn() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.connectOverRelay()
        let before = h.sockets.count
        h.transport.setForeground(false)
        h.advance(5 * directCheckInterval)
        #expect(h.sockets.count == before)

        h.transport.setForeground(true)
        #expect(h.sockets.count == before + 1)
        #expect(h.latest.url == lan)
    }

    @Test("re-races from the direct addresses when the network changes")
    func networkChangeReraces() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.connectOverRelay()
        h.transport.networkChanged()
        #expect(h.socket(at: relayURL).closed)
        #expect(h.latest.url == lan)
        h.latest.open()
        h.latest.challenge()
        #expect(h.latest.sent.count == 1)
        #expect(h.latest.sent.allSatisfy { $0.isProof })
    }

    @Test("races the relay alone when a direct address refuses the token, until the network changes")
    func relayAloneAfterRefusal() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.socket(at: lan).open()
        h.socket(at: lan).challenge()
        h.socket(at: lan).drop(Transport.closeUnauthorized)
        #expect(h.urls == [lan, relayURL])
        h.handshake(["call-keys"])
        #expect(!h.statuses.contains(.unauthorized))
        #expect(h.statuses.last == .connected)

        h.advance(3 * directCheckInterval)
        #expect(h.urls == [lan, relayURL])

        h.transport.networkChanged()
        #expect(h.urls == [lan, relayURL, lan])
    }

    @Test("stops when the relay refuses the token")
    func refusedRelay() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.advance(relayDelay)
        h.socket(at: relayURL).open()
        h.socket(at: relayURL).challenge()
        h.socket(at: relayURL).drop(Transport.closeUnauthorized)
        h.advance(60_000)
        #expect(h.urls == [lan, relayURL])
        #expect(h.statuses.last == .unauthorized)
    }

    @Test("dials only the direct addresses in the round after a direct check answers")
    func directRound() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.connectOverRelay()
        h.advance(directCheckInterval)
        h.latest.open()
        h.advance(connectTimeout - 1)
        #expect(h.urls == [lan, relayURL, lan, lan])
    }

    @Test("races both routes at once when no direct address opens in the direct round")
    func directRoundFails() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.connectOverRelay()
        h.advance(directCheckInterval)
        h.latest.open()
        h.advance(connectTimeout)
        #expect(h.urls == [lan, relayURL, lan, lan, lan])
        h.advance(relayDelay)
        #expect(h.urls == [lan, relayURL, lan, lan, lan, relayURL])
    }

    @Test("keeps the open socket when the dials change and uses them from the next round")
    func setDials() {
        let h = Harness([direct(lan)])
        h.handshake(["call-keys"])
        let first = h.latest
        h.transport.setDials([direct(tailscale), relay(relayURL)])
        #expect(!first.closed)
        _ = h.call("threads.list")
        #expect(first.calls().count == 1)

        first.drop()
        h.advance(500)
        #expect(h.latest.url == tailscale)
        h.advance(relayDelay)
        #expect(h.latest.url == relayURL)
    }

    @Test(
        "races the relay alone when a direct ready carries a wrong proof or no proof",
        arguments: [#"{"type":"ready","version":1,"proof":"00"}"#, #"{"type":"ready","version":1}"#])
    func unprovenDirectReady(answer: String) async {
        let h = Harness([direct(lan), relay(relayURL)])
        let read = h.call("threads.list")
        h.socket(at: lan).open()
        h.socket(at: lan).challenge()
        h.socket(at: lan).receive(answer)
        #expect(h.socket(at: lan).closed)
        #expect(h.socket(at: lan).calls() == [])
        #expect(h.urls == [lan, relayURL])
        #expect(!h.statuses.contains(.connected))
        #expect(!h.statuses.contains(.unauthorized))

        h.handshake()
        #expect(h.statuses.last == .connected)
        #expect(await read.isPending)
    }

    @Test("races the relay alone when a direct address says ready without a challenge")
    func directReadyWithoutChallenge() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.socket(at: lan).open()
        h.socket(at: lan).ready()
        #expect(h.socket(at: lan).closed)
        #expect(h.urls == [lan, relayURL])
        #expect(!h.statuses.contains(.connected))
    }

    @Test("stops when the relay's ready proves a different token")
    func relayProvesOtherToken() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.advance(relayDelay)
        h.socket(at: relayURL).open()
        h.socket(at: relayURL).challenge()
        h.socket(at: relayURL).receive(#"{"type":"ready","version":1,"proof":"00"}"#)
        #expect(h.socket(at: relayURL).closed)
        #expect(h.statuses.last == .unauthorized)
    }

    @Test("sends nothing to a direct address that does not challenge, and races the relay alone")
    func directWithoutChallenge() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.socket(at: lan).open()
        h.advance(challengeWait - 1)
        #expect(h.socket(at: lan).sent == [])
        #expect(h.urls == [lan])
        h.advance(1)
        #expect(h.socket(at: lan).sent == [])
        #expect(h.socket(at: lan).closed)
        #expect(h.urls == [lan, relayURL])
        #expect(!h.statuses.contains(.unauthorized))

        h.handshake()
        #expect(h.statuses.last == .connected)
    }

    @Test("sends the token to a relay that does not challenge")
    func relayWithoutChallenge() {
        let h = Harness([direct(lan), relay(relayURL)])
        h.advance(relayDelay)
        h.socket(at: relayURL).open()
        h.advance(challengeWait - 1)
        #expect(h.socket(at: relayURL).sent == [])
        h.advance(1)
        #expect(h.socket(at: relayURL).sent == [.auth(token: token)])
        h.socket(at: relayURL).ready()
        #expect(h.statuses.last == .connected)
    }

    @Test("sends the token to a direct address that does not challenge when the pairing has no relay")
    func directWithoutRelay() {
        let h = Harness([direct(lan)])
        h.latest.open()
        h.advance(challengeWait - 1)
        #expect(h.latest.sent == [])
        h.advance(1)
        #expect(h.latest.sent == [.auth(token: token)])
        h.latest.ready()
        #expect(h.statuses.last == .connected)
    }

    @Test("stop fails pending calls and never reconnects")
    func stop() async {
        let h = Harness()
        h.handshake()
        let send = h.call("threads.send", "{}")
        h.transport.stop()
        h.advance(60_000)
        #expect(await send.error?.tag == "Offline")
        #expect(h.sockets.count == 1)
        #expect(h.latest.closed)
    }
}
