import Foundation
import Testing

@testable import HinaCodeKit

private func newId() -> String { "new" }

private func machine(_ environmentId: String, hosts: [String] = ["192.168.1.20"]) -> RelayMachine {
    RelayMachine(
        environmentId: environmentId, name: environmentId,
        pairing: RelayMachine.Pairing(
            hosts: hosts, port: 48081, token: "token-\(environmentId)", relay: "\(environmentId).hinacode.app"))
}

private func entry(environmentId: String?, source: StoredServer.Source) -> StoredServer {
    StoredServer(
        id: environmentId ?? "none", environmentId: environmentId, hosts: ["192.168.1.5"], port: 47821,
        token: "t", source: source)
}

@Suite("planRelaySync")
struct PlanRelaySyncTests {
    @Test("adds every listed machine but this one")
    func addsEveryListedMachine() {
        let (upsert, _) = planRelaySync(
            entries: [], machines: [machine("home-server"), machine("this-desktop"), machine("agent-vm")],
            selfId: "this-desktop")
        #expect(upsert.map(\.environmentId) == ["home-server", "agent-vm"])
    }

    @Test("skips a machine whose pairing no socket can use")
    func skipsUnusable() {
        let (upsert, _) = planRelaySync(
            entries: [], machines: [machine("broken", hosts: ["has space"]), machine("home-server")], selfId: nil)
        #expect(upsert.map(\.environmentId) == ["home-server"])
    }

    @Test("drops a relay entry the list no longer has, and never a paired one")
    func dropsUnlisted() {
        let hidden = entry(environmentId: "agent-vm", source: .relay)
        let paired = entry(environmentId: "laptop", source: .pairing)
        let kept = entry(environmentId: "home-server", source: .relay)
        let (_, drop) = planRelaySync(entries: [hidden, paired, kept], machines: [machine("home-server")], selfId: nil)
        #expect(drop == [hidden])
    }

    @Test("drops a relay entry for a machine whose pairing became unusable")
    func dropsUnusable() {
        let stale = entry(environmentId: "broken", source: .relay)
        let (_, drop) = planRelaySync(
            entries: [stale], machines: [machine("broken", hosts: ["has space"])], selfId: nil)
        #expect(drop == [stale])
    }
}

private func relayServer(
    id: String = "a", name: String? = "studio", environmentId: String? = "env-a", hosts: [String] = ["192.168.1.5"],
    port: Int = 47821, token: String = "abc", relay: String? = "studio.relay.example.com",
    source: StoredServer.Source = .pairing
) -> StoredServer {
    StoredServer(
        id: id, name: name, environmentId: environmentId, hosts: hosts, port: port, token: token, relay: relay,
        source: source)
}

private func studioMachine(name: String = "Studio") -> RelayMachine {
    RelayMachine(
        environmentId: "env-a", name: name,
        pairing: RelayMachine.Pairing(
            hosts: ["100.64.0.2"], port: 47822, token: "rotated", relay: "studio.relay.example.com"))
}

@Suite("applyRelayMachines")
struct ApplyRelayMachinesTests {
    @Test("adds a machine it has not seen as a relay server")
    func addsMachine() {
        #expect(
            applyRelayMachines(servers: [], machines: [studioMachine()], newId: newId) == [
                StoredServer(
                    id: "new", name: "Studio", environmentId: "env-a", hosts: ["100.64.0.2"], port: 47822,
                    token: "rotated", relay: "studio.relay.example.com", source: .relay)
            ])
    }

    @Test("refreshes a QR-paired server's pairing by environment id and keeps its name and source")
    func refreshesByEnvironmentId() {
        let paired = relayServer(relay: nil)
        #expect(
            applyRelayMachines(servers: [paired], machines: [studioMachine()], newId: newId) == [
                relayServer(hosts: ["100.64.0.2"], port: 47822, token: "rotated")
            ])
    }

    @Test("renames a relay server the owner renamed")
    func renamesRelayServer() {
        let refreshed = applyRelayMachines(
            servers: [relayServer(source: .relay)], machines: [studioMachine(name: "Renamed")], newId: newId)
        #expect(refreshed.count == 1)
        #expect(refreshed[0].id == "a" && refreshed[0].name == "Renamed" && refreshed[0].source == .relay)
    }

    @Test("matches by relay hostname when the server's environment id is unknown")
    func matchesByRelay() {
        let refreshed = applyRelayMachines(
            servers: [relayServer(environmentId: nil)], machines: [studioMachine()], newId: newId)
        #expect(refreshed.count == 1)
        #expect(
            refreshed[0].id == "a" && refreshed[0].environmentId == "env-a" && refreshed[0].token == "rotated"
                && refreshed[0].source == .pairing)
    }

    @Test("drops a relay server the list no longer has")
    func dropsUnlisted() {
        let servers = [relayServer(source: .relay), relayServer(id: "b", environmentId: "env-b", relay: nil)]
        #expect(applyRelayMachines(servers: servers, machines: [], newId: newId).map(\.id) == ["b"])
    }

    @Test("keeps a QR-paired server the list no longer has")
    func keepsPaired() {
        #expect(applyRelayMachines(servers: [relayServer()], machines: [], newId: newId) == [relayServer()])
    }

    @Test("drops every relay server for an empty list")
    func dropsEveryRelayServer() {
        let servers = [
            relayServer(source: .relay),
            relayServer(id: "b", environmentId: "env-b", relay: "b.relay.example.com", source: .relay),
        ]
        #expect(applyRelayMachines(servers: servers, machines: [], newId: newId).isEmpty)
    }
}

private let account = RelayAccount(serviceUrl: "https://relay.example.com/", ownerToken: "owner")

private func httpResponse(_ status: Int, _ body: String) -> (Data, HTTPURLResponse) {
    (
        Data(body.utf8),
        HTTPURLResponse(
            url: URL(string: "https://relay.example.com/v1/machines")!, statusCode: status, httpVersion: nil,
            headerFields: nil)!
    )
}

private func machinesBody(_ machines: [RelayMachine]) -> String {
    struct Body: Encodable {
        var machines: [RelayMachine]
    }
    return String(decoding: try! JSONEncoder().encode(Body(machines: machines)), as: UTF8.self)
}

private func answering(_ status: Int, _ body: String) -> RelayHTTP {
    { _ in httpResponse(status, body) }
}

@MainActor
@Suite("fetchRelayMachines")
struct FetchRelayMachinesTests {
    @Test("lists the machines with the owner token")
    func listsMachines() async {
        var asked: (url: String, authorization: String?)?
        let http: RelayHTTP = { request in
            asked = (request.url!.absoluteString, request.value(forHTTPHeaderField: "Authorization"))
            return httpResponse(200, machinesBody([studioMachine()]))
        }
        let result = await fetchRelayMachines(account: account, http: http)
        #expect(result == .machines([studioMachine()]))
        #expect(asked?.url == "https://relay.example.com/v1/machines")
        #expect(asked?.authorization == "Bearer \(account.ownerToken)")
    }

    @Test("reports a refused owner token")
    func reportsRefused() async {
        let result = await fetchRelayMachines(
            account: account, http: answering(401, #"{"error":"unauthorized"}"#))
        #expect(result == .unauthorized)
    }

    @Test("fails for an answer of the wrong shape")
    func failsWrongShape() async {
        let result = await fetchRelayMachines(
            account: account, http: answering(200, #"{"machines":[{"name":"studio"}]}"#))
        #expect(result == .failed(.badAnswer))
    }

    @Test("fails for a server error")
    func failsServerError() async {
        let result = await fetchRelayMachines(account: account, http: answering(500, "{}"))
        #expect(result == .failed(.badStatus(500)))
    }

    @Test("fails for an unreachable relay")
    func failsUnreachable() async {
        let http: RelayHTTP = { _ in throw URLError(.notConnectedToInternet) }
        let result = await fetchRelayMachines(account: account, http: http)
        #expect(result == .failed(.unreachable))
    }
}

@MainActor
final class RelayStub {
    var token = "first"
    var syncs = 0

    func http(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        syncs += 1
        let body =
            #"{"machines":[{"environmentId":"env-a","name":"Studio","pairing":{"hosts":["192.168.1.5"],"port":47821,"token":"\#(token)","relay":"studio.relay.example.com"}}]}"#
        return httpResponse(200, body)
    }
}

@MainActor
@Suite("RelayAccountStore")
struct RelayAccountStoreTests {
    let timers = ManualTimers()
    let sockets = HubSockets()
    let stub = RelayStub()
    let hub: ServerHub
    let store: RelayAccountStore

    init() {
        let sockets = sockets
        let stub = stub
        let storage = MemoryServerStorage()
        hub = ServerHub(storage: storage, timers: timers, createSocket: { sockets.make($0) })
        store = RelayAccountStore(
            hub: hub, storage: storage, timers: timers, http: { try await stub.http($0) }, newId: { "relay-1" })
    }

    private func flush() async {
        for _ in 0..<100 { await Task.yield() }
    }

    private func setUp() async {
        await store.signIn(serviceUrl: "https://relay.example.com", ownerToken: "owner")
        stub.syncs = 0
    }

    private func tearDown() async {
        await store.signOut()
        hub.setServers([])
    }

    /// Opens the direct socket and has it refuse the token, then the relay socket the hub dials next, which has the
    /// last word.
    private func refuse() {
        let direct = sockets.all.last { $0.url.hasPrefix("ws://") }!
        direct.open()
        direct.drop(4001)
        let relay = sockets.all.last { $0.url.hasPrefix("wss://") }!
        relay.open()
        relay.drop(4001)
    }

    @Test("syncs while a relay server refuses its token, until the sync brings a new one")
    func syncsWhileRefused() async {
        await setUp()
        refuse()
        await flush()
        #expect(stub.syncs == 1)
        timers.advance(by: .seconds(15))
        await flush()
        #expect(stub.syncs == 2)
        timers.advance(by: .seconds(15))
        await flush()
        #expect(stub.syncs == 3)

        stub.token = "rotated"
        timers.advance(by: .seconds(15))
        await flush()
        #expect(stub.syncs == 4)
        #expect(hub.servers.first?.stored.token == "rotated")
        #expect(hub.servers.first?.status == .connecting)
        timers.advance(by: .seconds(60))
        await flush()
        #expect(stub.syncs == 4)
        await tearDown()
    }

    @Test("does not sync for a QR-paired server that refuses its token")
    func doesNotSyncForPaired() async {
        await setUp()
        hub.setServers(
            hub.storedServers().map { server in
                var server = server
                server.source = .pairing
                return server
            })
        refuse()
        timers.advance(by: .seconds(60))
        await flush()
        #expect(stub.syncs == 0)
        await tearDown()
    }
}
