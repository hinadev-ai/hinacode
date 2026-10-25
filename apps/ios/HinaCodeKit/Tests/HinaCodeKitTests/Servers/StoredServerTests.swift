import Foundation
import Testing

@testable import HinaCodeKit

private func server(
    id: String = "a", name: String? = "studio", environmentId: String? = "env-a",
    hosts: [String] = ["100.64.0.2", "192.168.1.5"], port: Int = 47821, token: String = "abc", relay: String? = nil,
    source: StoredServer.Source = .pairing
) -> StoredServer {
    StoredServer(
        id: id, name: name, environmentId: environmentId, hosts: hosts, port: port, token: token, relay: relay,
        source: source)
}

private func encoded(_ servers: [StoredServer]) -> Data {
    try! JSONEncoder().encode(servers)
}

/// `server` as an older app saved it, without `key`.
private func encoded(_ server: StoredServer, without key: String) -> Data {
    var object = try! JSONSerialization.jsonObject(with: encoded([server])) as! [[String: Any]]
    object[0][key] = nil
    return try! JSONSerialization.data(withJSONObject: object)
}

private func pairing(_ hosts: [String], _ port: Int, _ token: String, _ relay: String? = nil) -> PairingTarget {
    PairingTarget(hosts: hosts, port: port, token: token, relay: relay)
}

private func newId() -> String { "new" }

@Suite("StoredServer.parseList")
struct StoredServerParseTests {
    @Test("reads every server in order")
    func readsInOrder() {
        let servers = [server(), server(id: "b", name: nil, environmentId: nil, hosts: ["10.0.0.9"])]
        #expect(StoredServer.parseList(encoded(servers)) == servers)
    }

    @Test("reads an entry saved before the relay existed as having none")
    func readsWithoutRelay() {
        #expect(StoredServer.parseList(encoded(server(), without: "relay")) == [server()])
    }

    @Test("reads an entry saved before the relay sync as paired by QR code")
    func readsWithoutSource() {
        #expect(StoredServer.parseList(encoded(server(), without: "source")) == [server()])
    }

    @Test("keeps a server's source across a save")
    func keepsSource() {
        let servers = [server(source: .relay)]
        #expect(StoredServer.parseList(encoded(servers)) == servers)
    }

    @Test("keeps a server's relay across a save")
    func keepsRelay() {
        let servers = [server(relay: "studio.example.com")]
        #expect(StoredServer.parseList(encoded(servers)) == servers)
    }

    @Test("drops a bad entry and keeps the rest")
    func dropsBadEntry() {
        let raw = encoded([server(hosts: ["bad/path"]), server(id: "b", port: 0), server(id: "c")])
        #expect(StoredServer.parseList(raw).map(\.id) == ["c"])
    }

    @Test("reads nothing and unreadable JSON as no servers", arguments: [nil, "not json"])
    func readsNothing(raw: String?) {
        #expect(StoredServer.parseList(raw.map { Data($0.utf8) }) == [])
    }
}

@Suite("StoredServer.adding")
struct StoredServerAddingTests {
    @Test("adds a server it has not seen")
    func addsNew() {
        let (servers, id) = StoredServer.adding(pairing(["10.0.0.9"], 47821, "xyz"), to: [server()], newId: newId)
        #expect(id == "new")
        #expect(servers.map(\.id) == ["a", "new"])
        #expect(servers[1].source == .pairing)
    }

    @Test("keeps the source of a relay server paired again by QR code")
    func keepsRelaySource() {
        let (servers, _) = StoredServer.adding(
            pairing(["192.168.1.5"], 47821, "rotated"), to: [server(source: .relay)], newId: newId)
        #expect(servers[0].source == .relay)
    }

    @Test("updates the token of a server paired again at an address it had")
    func updatesToken() {
        let (servers, id) = StoredServer.adding(
            pairing(["192.168.1.5"], 47821, "rotated"), to: [server()], newId: newId)
        #expect(id == "a")
        #expect(servers == [server(hosts: ["192.168.1.5"], token: "rotated")])
    }

    @Test("keeps a server on another port apart")
    func keepsOtherPortApart() {
        let (servers, _) = StoredServer.adding(pairing(["192.168.1.5"], 47822, "abc"), to: [server()], newId: newId)
        #expect(servers.count == 2)
    }

    @Test("updates the server with the same relay when it is paired again at new addresses")
    func updatesBySameRelay() {
        let target = pairing(["10.0.0.9"], 48081, "rotated", "studio.example.com")
        let (servers, id) = StoredServer.adding(target, to: [server(relay: target.relay)], newId: newId)
        #expect(id == "a")
        #expect(servers == [server(hosts: target.hosts, port: target.port, token: target.token, relay: target.relay)])
    }
}
