import Foundation
import Observation

/// The relay this phone signed in to. The owner token lists every machine the owner shows on their devices.
public struct RelayAccount: Codable, Hashable, Sendable {
    public var serviceUrl: String
    public var ownerToken: String

    public init(serviceUrl: String, ownerToken: String) {
        self.serviceUrl = serviceUrl
        self.ownerToken = ownerToken
    }
}

/// Why talking to the relay failed, for the app to localize.
public enum RelayError: Equatable, Sendable {
    case unreachable
    case badStatus(Int)
    case badAnswer
    /// The relay refused the owner token at sign-in.
    case tokenRefused
    /// The relay refused the owner token on a sync, so it was rotated.
    case tokenRotated
    indirect case syncFailed(RelayError)
}

/// A machine the owner linked to the relay and shows on their devices, with the pairing a QR code would carry.
struct RelayMachine: Codable, Hashable, Sendable {
    struct Pairing: Codable, Hashable, Sendable {
        var hosts: [String]
        var port: Int
        var token: String
        var relay: String

        var target: PairingTarget { PairingTarget(hosts: hosts, port: port, token: token, relay: relay) }

        private enum CodingKeys: String, CodingKey {
            case hosts, port, token, relay
        }

        init(hosts: [String], port: Int, token: String, relay: String) {
            self.hosts = hosts
            self.port = port
            self.token = token
            self.relay = relay
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            hosts = try container.decode([String].self, forKey: .hosts)
            guard !hosts.isEmpty else {
                throw DecodingError.dataCorruptedError(
                    forKey: .hosts, in: container, debugDescription: "A pairing has at least one host")
            }
            port = try container.decode(Int.self, forKey: .port)
            token = try container.decode(String.self, forKey: .token)
            relay = try container.decode(String.self, forKey: .relay)
        }
    }

    var environmentId: String
    var name: String
    var pairing: Pairing
}

/// The answer to the relay service's `GET /v1/machines`.
private struct RelayMachineList: Decodable {
    var machines: [RelayMachine]
}

enum RelayMachinesResult: Equatable {
    case machines([RelayMachine])
    case unauthorized
    case failed(RelayError)
}

/// What a client does with the relay's list. Every listed machine but this one, with a pairing a socket can use,
/// is added or refreshed. An entry the relay added before is dropped once the list no longer has it, because the
/// owner hid or unlinked it. An entry paired by QR code is never dropped.
func planRelaySync(
    entries: [StoredServer], machines: [RelayMachine], selfId: String?
) -> (upsert: [RelayMachine], drop: [StoredServer]) {
    let upsert = machines.filter { machine in
        machine.environmentId != selfId && PairingTarget.parse(machine.pairing.target.url) != nil
    }
    let listed = Set(upsert.map(\.environmentId))
    let drop = entries.filter { entry in
        entry.source == .relay && (entry.environmentId == nil || !listed.contains(entry.environmentId!))
    }
    return (upsert, drop)
}

typealias RelayHTTP = @MainActor (URLRequest) async throws -> (Data, HTTPURLResponse)

/// Asks the relay for the machines its owner shows on their devices. A 401 means the owner token was rotated.
func fetchRelayMachines(account: RelayAccount, http: RelayHTTP) async -> RelayMachinesResult {
    let base = account.serviceUrl.reversed().drop { $0 == "/" }.reversed()
    guard let url = URL(string: String(base) + "/v1/machines") else { return .failed(.unreachable) }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(account.ownerToken)", forHTTPHeaderField: "Authorization")
    let data: Data
    let response: HTTPURLResponse
    do {
        (data, response) = try await http(request)
    } catch {
        return .failed(.unreachable)
    }
    if response.statusCode == 401 { return .unauthorized }
    guard (200..<300).contains(response.statusCode) else { return .failed(.badStatus(response.statusCode)) }
    guard let list = try? JSONDecoder().decode(RelayMachineList.self, from: data) else {
        return .failed(.badAnswer)
    }
    return .machines(list.machines)
}

/// The stored servers after a sync: each listed machine refreshes the server with its environment id or relay
/// hostname, or is added as a relay server, and relay servers the list lost are dropped. QR-paired servers keep
/// their name and are never dropped.
func applyRelayMachines(
    servers: [StoredServer], machines: [RelayMachine], newId: () -> String
) -> [StoredServer] {
    let (upsert, drop) = planRelaySync(entries: servers, machines: machines, selfId: nil)
    let dropped = Set(drop.map(\.id))
    var next = servers.filter { !dropped.contains($0.id) }
    for machine in upsert {
        let same =
            next.firstIndex { $0.environmentId == machine.environmentId }
            ?? next.firstIndex { $0.relay == machine.pairing.relay }
        guard let same else {
            next.append(
                StoredServer(
                    id: newId(), name: machine.name, environmentId: machine.environmentId,
                    target: machine.pairing.target, source: .relay))
            continue
        }
        var refreshed = next[same]
        refreshed.target = machine.pairing.target
        refreshed.environmentId = machine.environmentId
        if refreshed.source == .relay { refreshed.name = machine.name }
        next[same] = refreshed
    }
    return next
}

/// The phone's relay account: sign in, syncing the machines the owner shows on their devices into the hub as relay
/// servers, and sign out. A port of `apps/mobile/src/stores/relay-account.ts`.
@MainActor
@Observable
public final class RelayAccountStore {
    /// Null while signed out.
    public private(set) var serviceUrl: String?
    public private(set) var syncedAt: String?
    /// How many machines the last sync listed.
    public private(set) var machines: Int?
    /// Why the last sync failed.
    public private(set) var error: RelayError?
    /// The relay refused the owner token, so it was rotated and the phone has to sign in again.
    public private(set) var unauthorized = false
    public private(set) var syncing = false

    @ObservationIgnored private let hub: ServerHub
    @ObservationIgnored private let storage: any ServerStorage
    @ObservationIgnored private let timers: any Timers
    @ObservationIgnored private let http: @MainActor (URLRequest) async throws -> (Data, HTTPURLResponse)
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let newId: () -> String
    // Outside the observable state, so no screen ever renders the owner token.
    @ObservationIgnored private var account: RelayAccount?
    @ObservationIgnored private var inFlight: Task<Void, Never>?
    @ObservationIgnored private var refusedTimer: TimerHandle?
    @ObservationIgnored private var hubWatcher: Task<Void, Never>?

    private static let refusedSyncInterval: Duration = .seconds(15)

    public init(
        hub: ServerHub,
        storage: any ServerStorage = KeychainServerStorage(),
        timers: any Timers = SystemTimers.shared,
        http: @escaping @MainActor (URLRequest) async throws -> (Data, HTTPURLResponse) = { request in
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            return (data, http)
        },
        now: @escaping () -> Date = Date.init,
        newId: @escaping () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.hub = hub
        self.storage = storage
        self.timers = timers
        self.http = http
        self.now = now
        self.newId = newId
        hubWatcher = Task { [weak self, hub] in
            for await _ in Observations({ hub.servers.map { ($0.source == .relay, $0.status == .unauthorized) } }) {
                self?.syncWhileRefused()
            }
        }
    }

    /// Reads the saved account once at launch and syncs with it.
    public func restore() async {
        account = storage.loadRelayAccount()
        guard let account else { return }
        serviceUrl = account.serviceUrl
        await sync()
    }

    /// Saves the account only when the relay accepts it. Returns why it did not, or nil.
    @discardableResult
    public func signIn(serviceUrl: String, ownerToken: String) async -> RelayError? {
        let next = RelayAccount(serviceUrl: serviceUrl, ownerToken: ownerToken)
        switch await fetchRelayMachines(account: next, http: http) {
        case .unauthorized:
            return .tokenRefused
        case .failed(let error):
            return error
        case .machines(let machines):
            account = next
            storage.saveRelayAccount(next)
            applyMachines(machines)
            self.serviceUrl = next.serviceUrl
            syncedAt = Self.isoNow(now())
            self.machines = machines.count
            error = nil
            unauthorized = false
            syncWhileRefused()
            return nil
        }
    }

    public func sync() async {
        guard let account else { return }
        if let inFlight {
            await inFlight.value
            return
        }
        let task = Task { await run(account) }
        inFlight = task
        await task.value
        inFlight = nil
    }

    /// Forgets the account and the servers it added.
    public func signOut() async {
        account = nil
        serviceUrl = nil
        syncedAt = nil
        machines = nil
        error = nil
        unauthorized = false
        syncWhileRefused()
        applyMachines([])
        storage.saveRelayAccount(nil)
    }

    private func run(_ current: RelayAccount) async {
        syncing = true
        defer { syncing = false }
        let result = await fetchRelayMachines(account: current, http: http)
        if account != current { return }
        switch result {
        case .machines(let machines):
            applyMachines(machines)
            syncedAt = Self.isoNow(now())
            self.machines = machines.count
            error = nil
            unauthorized = false
        case .unauthorized:
            error = .tokenRotated
            unauthorized = true
            syncWhileRefused()
        case .failed(let failure):
            error = .syncFailed(failure)
        }
    }

    private func applyMachines(_ machines: [RelayMachine]) {
        let before = hub.storedServers()
        let after = applyRelayMachines(servers: before, machines: machines, newId: newId)
        if after == before { return }
        hub.setServers(after)
    }

    /// A machine that rotates its token closes the phone's sockets with 4002 and publishes the new token to the relay
    /// a moment later. So while a relay server refuses its token, sync now and every 15 seconds in the foreground; a
    /// changed token makes `setServers` redial it.
    private func syncWhileRefused() {
        let refused =
            account != nil && !unauthorized
            && hub.servers.contains { $0.source == .relay && $0.status == .unauthorized }
        if !refused {
            refusedTimer?.cancel()
            refusedTimer = nil
            return
        }
        if refusedTimer != nil { return }
        refusedTimer = timers.every(Self.refusedSyncInterval) { [weak self] in
            guard let self, hub.isForeground else { return }
            Task { await self.sync() }
        }
        Task { await sync() }
    }

    private static func isoNow(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}
