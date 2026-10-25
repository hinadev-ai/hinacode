import Foundation
import Observation

/// The multi-server layer between the transports and the stores, a port of `apps/mobile/src/lib/connection.ts`. It
/// keeps one socket open to each paired server and routes each call to the server that should run it.
@MainActor
@Observable
public final class ServerHub: Caller {
    /// A stored server plus the state of its link.
    public struct Server: Identifiable, Sendable {
        public internal(set) var stored: StoredServer
        public internal(set) var status: TransportStatus
        /// Why the server refused us, shown in Settings and on the pairing screen.
        public internal(set) var error: String?
        /// What the server of the latest handshake understands, e.g. `terminal-attach`.
        public internal(set) var features: Set<String>
        /// Counts this server's successful handshakes.
        public internal(set) var generation: Int
        /// Whether this server has answered `threads.list` since the app started, so the ids it owns are known.
        public internal(set) var listed: Bool

        public var id: String { stored.id }
        public var name: String? { stored.name }
        public var environmentId: String? { stored.environmentId }
        public var hosts: [String] { stored.hosts }
        public var port: Int { stored.port }
        public var relay: String? { stored.relay }
        public var source: StoredServer.Source { stored.source }

        init(stored: StoredServer) {
            self.stored = stored
            status = .connecting
            error = nil
            features = []
            generation = 0
            listed = false
        }
    }

    /// In the order they were paired.
    public private(set) var servers: [Server] = []
    /// Whether any server would still take a call.
    public private(set) var paired = false
    /// The best status of any server, for code that only asks whether anything is connected.
    public private(set) var status: TransportStatus = .offline
    /// Counts every server's handshakes. Snapshots are reloaded after each one, since pushes sent meanwhile are lost.
    public private(set) var generation = 0
    /// What every connected server understands.
    public private(set) var features: Set<String> = []

    /// Called with every push from every server. One listener; the app model fans out.
    @ObservationIgnored public var onEvent: ((PushEvent) -> Void)?

    @ObservationIgnored private let storage: any ServerStorage
    @ObservationIgnored private let timers: any Timers
    @ObservationIgnored private let createSocket: (URL) -> SocketLike
    @ObservationIgnored private var transports: [String: Transport] = [:]
    @ObservationIgnored private let owners = Owners()
    /// Each server's last answer to an `all` method, listed while it is offline.
    @ObservationIgnored private var remembered: [String: [String: RememberedAnswer]] = [:]
    @ObservationIgnored private var lastSaved: [StoredServer] = []
    @ObservationIgnored private var ownerWaiters: [OwnerWaiter] = []
    @ObservationIgnored private var nextWaiterId = 0
    @ObservationIgnored private(set) var isForeground = true

    private struct RememberedAnswer {
        let payload: String
        let result: any Sendable
    }

    private struct OwnerWaiter {
        let id: Int
        let entity: Entity
        let entityId: String
        let continuation: CheckedContinuation<String?, Never>
        let timer: TimerHandle
    }

    private static let offlineError = RpcError("Offline", "Not connected to any server.")

    public init(
        storage: any ServerStorage = KeychainServerStorage(),
        timers: any Timers = SystemTimers.shared,
        createSocket: @escaping (URL) -> SocketLike = { URLSessionSocket(url: $0) }
    ) {
        self.storage = storage
        self.timers = timers
        self.createSocket = createSocket
    }

    /// Reads the stored list and opens the sockets, once at launch.
    public func restore() {
        let loaded = storage.loadServers()
        lastSaved = loaded
        setServers(loaded)
    }

    /// Adds a server, or updates the one this pairing reaches again. Returns its id.
    @discardableResult
    public func pair(_ target: PairingTarget) -> String {
        let (list, id) = StoredServer.adding(target, to: storedServers())
        setServers(list)
        return id
    }

    /// Unpairs one server. Its projects and threads leave the lists.
    public func forget(id: String) {
        setServers(storedServers().filter { $0.id != id })
    }

    /// The servers as they are saved, without their connection state.
    func storedServers() -> [StoredServer] {
        servers.map(\.stored)
    }

    /// Keeps one socket open to each of `list`: opens the new ones, closes the ones no longer listed, redials a
    /// server whose addresses or token changed, and points one whose relay changed at the new dial plan without
    /// dropping its socket. The list is saved whenever its stored form changes.
    public func setServers(_ list: [StoredServer]) {
        let previous = Dictionary(servers.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for id in previous.keys where !list.contains(where: { $0.id == id }) { close(id) }
        let next = list.map { stored -> Server in
            guard let existing = previous[stored.id] else { return Server(stored: stored) }
            if Self.sameTarget(existing.stored, stored) {
                if existing.stored.relay != stored.relay { transports[stored.id]?.setDials(stored.target.dialPlan) }
                var kept = existing
                kept.stored = stored
                return kept
            }
            close(stored.id)
            return Server(stored: stored)
        }
        apply(next)
        for server in next where transports[server.id] == nil { open(server.stored) }
    }

    /// Skips the remaining backoff of one server, or of all.
    public func reconnectNow(id: String? = nil) {
        for (serverId, transport) in transports where id == nil || id == serverId { transport.reconnectNow() }
    }

    /// The device switched networks, so the current sockets are probably dead even if they look open.
    public func networkChanged() {
        for transport in transports.values { transport.networkChanged() }
    }

    public func setForeground(_ foreground: Bool) {
        isForeground = foreground
        for transport in transports.values { transport.setForeground(foreground) }
    }

    /// Calls the server that owns the call's ids, every server for a list, or `server` for a call that names one;
    /// unnamed, that is the first connected server. While a server's link is down the call waits and is sent after
    /// its next handshake, so it runs once.
    public func call<Request, Response>(_ method: Method<Request, Response>, _ payload: Request, server: String?)
        async throws -> Response
    {
        let payloadData: Data?
        if payload is NoPayload {
            payloadData = nil
        } else {
            do {
                payloadData = try JSONEncoder().encode(payload)
            } catch {
                throw RpcError("SchemaError", "\(error)")
            }
        }
        if servers.isEmpty { throw Self.offlineError }
        switch method.route {
        case .all:
            return try await gather(method: method, payloadData: payloadData)
        case .owner(let entity, let key) where servers.count > 1:
            var owner: String?
            if let id = Self.payloadId(payloadData, key: key) { owner = await findOwner(entity, id) }
            guard let owner else { throw RpcError("NotFoundError", "No paired server has this anymore.") }
            return try await send(serverId: owner, method: method, payloadData: payloadData)
        default:
            let target =
                servers.first { $0.id == server } ?? servers.first { $0.status == .connected } ?? servers[0]
            return try await send(serverId: target.id, method: method, payloadData: payloadData)
        }
    }

    private static func sameTarget(_ a: StoredServer, _ b: StoredServer) -> Bool {
        a.port == b.port && a.token == b.token && a.hosts == b.hosts
    }

    private static func payloadId(_ data: Data?, key: String) -> String? {
        guard let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object[key] as? String
    }

    private func open(_ server: StoredServer) {
        let id = server.id
        var opened: Transport?
        let transport = Transport(
            dials: server.target.dialPlan, token: server.token,
            onStatus: { [weak self] status, error in
                guard let self, transports[id] === opened else { return }
                updateServer(id) { server in
                    server.status = status
                    server.error = error
                }
            },
            onReady: { [weak self] features, environment, relay in
                guard let self, transports[id] === opened else { return }
                updateServer(id) { server in
                    server.features = features
                    server.generation += 1
                    if server.stored.name == nil { server.stored.name = environment?.name }
                    if let environment { server.stored.environmentId = environment.id }
                }
                let current = servers
                let older = current.first { other in
                    other.id != id && environment != nil && other.stored.environmentId == environment?.id
                }
                if older != nil || relay != current.first(where: { $0.id == id })?.stored.relay {
                    setServers(
                        current.filter { $0.id != older?.id }.map { other in
                            var stored = other.stored
                            if other.id == id { stored.relay = relay }
                            return stored
                        })
                }
            },
            onEvent: { [weak self] event in
                guard let self else { return }
                owners.learn(serverId: id, fromPush: event)
                onEvent?(event)
            },
            createSocket: createSocket, timers: timers)
        opened = transport
        transports[id] = transport
        transport.start()
    }

    private func close(_ id: String) {
        transports[id]?.stop()
        transports[id] = nil
        owners.forget(id)
        remembered[id] = nil
    }

    private func updateServer(_ id: String, _ patch: (inout Server) -> Void) {
        apply(
            servers.map { server in
                var server = server
                if server.id == id { patch(&server) }
                return server
            })
    }

    private func apply(_ next: [Server]) {
        servers = next
        paired = next.contains { $0.status != .unauthorized }
        status = Self.bestStatus(next)
        generation = next.reduce(0) { $0 + $1.generation }
        let connected = next.filter { $0.status == .connected }
        features =
            connected.first.map { first in
                first.features.filter { feature in connected.allSatisfy { $0.features.contains(feature) } }
            } ?? []
        let stored = next.map(\.stored)
        if stored != lastSaved {
            lastSaved = stored
            storage.saveServers(stored)
        }
        notifyOwnerWaiters()
    }

    private static func bestStatus(_ servers: [Server]) -> TransportStatus {
        func rank(_ status: TransportStatus) -> Int {
            switch status {
            case .connected: 3
            case .connecting: 2
            case .offline: 1
            case .unauthorized: 0
            }
        }
        return servers.reduce(servers.isEmpty ? TransportStatus.offline : .unauthorized) { best, server in
            rank(server.status) > rank(best) ? server.status : best
        }
    }

    /// Whether every server has listed its threads or cannot, so an id none of them claimed belongs to none.
    private func ownersSettled() -> Bool {
        servers.allSatisfy { $0.listed || $0.status == .offline || $0.status == .unauthorized }
    }

    /// The server that owns `id`, waiting until the servers have listed what they own.
    private func findOwner(_ entity: Entity, _ id: String) async -> String? {
        if let owner = owners.owner(entity, id) { return owner }
        if ownersSettled() { return nil }
        return await withCheckedContinuation { continuation in
            nextWaiterId += 1
            let waiterId = nextWaiterId
            let timer = timers.after(Transport.connectTimeout) { [weak self] in
                guard let self, let index = ownerWaiters.firstIndex(where: { $0.id == waiterId }) else { return }
                ownerWaiters.remove(at: index).continuation.resume(returning: owners.owner(entity, id))
            }
            ownerWaiters.append(
                OwnerWaiter(id: waiterId, entity: entity, entityId: id, continuation: continuation, timer: timer))
        }
    }

    private func notifyOwnerWaiters() {
        var waiting: [OwnerWaiter] = []
        for waiter in ownerWaiters {
            if let owner = owners.owner(waiter.entity, waiter.entityId) {
                waiter.timer.cancel()
                waiter.continuation.resume(returning: owner)
            } else if ownersSettled() {
                waiter.timer.cancel()
                waiter.continuation.resume(returning: nil)
            } else {
                waiting.append(waiter)
            }
        }
        ownerWaiters = waiting
    }

    /// Sends one call to one server and learns the ids in its answer.
    private func send<Request, Response>(
        serverId: String, method: Method<Request, Response>, payloadData: Data?
    ) async throws -> Response {
        guard let transport = transports[serverId] else { throw Self.offlineError }
        let frame = try await transport.call(method.name, payload: payloadData, mutation: method.mutation)
        let result: Response = try await Self.decode(frame)
        owners.learn(serverId: serverId, method: method.name, result: result)
        if method.name == "threads.list" { updateServer(serverId) { $0.listed = true } }
        return stampProjects(method: method.name, result: result, serverId: serverId)
    }

    /// Decodes a result frame off the main actor, since transcripts can be megabytes.
    private static func decode<Response: Decodable & Sendable>(_ frame: Data) async throws -> Response {
        try await Task.detached(priority: .userInitiated) {
            do {
                return try JSONDecoder().decode(ResultEnvelope<Response>.self, from: frame).result.get()
            } catch let error as RpcError {
                throw error
            } catch {
                throw RpcError("SchemaError", "\(error)")
            }
        }.value
    }

    /// Asks every connected server and concatenates the lists. A server that is not connected, or does not answer
    /// within a few seconds, adds its last answer to the same call, so its threads stay listed while it is away.
    private func gather<Request, Response>(method: Method<Request, Response>, payloadData: Data?) async throws
        -> Response
    {
        guard let list = Response.self as? any HubListResponse.Type,
            let empty = list.hubEmptyAnswer as? Response
        else { fatalError("\(method.name) is routed to every server but answers \(Response.self), not a list") }
        let key = payloadData.map { String(decoding: $0, as: UTF8.self) } ?? "null"
        let tasks = servers.map { server in
            Task { await gatherOne(server: server, method: method, payloadData: payloadData, key: key, empty: empty) }
        }
        var parts: [Any] = []
        for task in tasks { parts.append(await task.value) }
        guard let merged = list.hubConcatAnswers(parts) as? Response else {
            fatalError("\(method.name) is routed to every server but answers \(Response.self), not a list")
        }
        return merged
    }

    private func gatherOne<Request, Response>(
        server: Server, method: Method<Request, Response>, payloadData: Data?, key: String, empty: Response
    ) async -> Response {
        let last = remembered[server.id]?[method.name]
        let fallback = last?.payload == key ? (last?.result as? Response ?? empty) : empty
        if server.status != .connected { return fallback }
        guard let answer = await probe(serverId: server.id, method: method, payloadData: payloadData) else {
            return fallback
        }
        var answers = remembered[server.id] ?? [:]
        answers[method.name] = RememberedAnswer(payload: key, result: answer)
        remembered[server.id] = answers
        return answer
    }

    /// One server's answer within the probe timeout, or nil. A late answer still teaches its ids inside `send`.
    private func probe<Request, Response>(
        serverId: String, method: Method<Request, Response>, payloadData: Data?
    ) async -> Response? {
        let box = ProbeBox()
        return await withCheckedContinuation { (continuation: CheckedContinuation<Response?, Never>) in
            let timer = timers.after(Transport.probeTimeout) {
                if box.finish() { continuation.resume(returning: nil) }
            }
            Task {
                let answer = try? await send(serverId: serverId, method: method, payloadData: payloadData)
                if box.finish() {
                    timer.cancel()
                    continuation.resume(returning: answer)
                }
            }
        }
    }
}

/// Whether a probe has already been answered, by the server or by its timeout.
@MainActor
private final class ProbeBox {
    private var done = false

    /// Marks the probe answered, returning whether this was the first answer.
    func finish() -> Bool {
        if done { return false }
        done = true
        return true
    }
}

/// A method answer that gathers by concatenation. Only arrays are ever routed to every server.
protocol HubListResponse {
    static var hubEmptyAnswer: Any { get }
    static func hubConcatAnswers(_ parts: [Any]) -> Any?
}

extension Array: HubListResponse {
    static var hubEmptyAnswer: Any { [Element]() }

    static func hubConcatAnswers(_ parts: [Any]) -> Any? {
        var joined: [Element] = []
        for part in parts {
            guard let list = part as? [Element] else { return nil }
            joined += list
        }
        return joined
    }
}
