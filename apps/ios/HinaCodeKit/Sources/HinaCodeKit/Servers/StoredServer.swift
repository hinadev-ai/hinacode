import Foundation

/// A paired HinaCode, as the phone saves it. `id` is made by this phone, so calls can route before the first
/// handshake. `name` and `environmentId` come from the server's first `ready` frame.
public struct StoredServer: Codable, Hashable, Sendable, Identifiable {
    /// Where the entry came from. A relay sync adds, refreshes and drops `relay` entries only.
    public enum Source: String, Codable, Hashable, Sendable {
        case pairing, relay
    }

    public var id: String
    public var name: String?
    public var environmentId: String?
    public var hosts: [String]
    public var port: Int
    public var token: String
    public var relay: String?
    public var source: Source

    public init(
        id: String, name: String? = nil, environmentId: String? = nil, hosts: [String], port: Int, token: String,
        relay: String? = nil, source: Source = .pairing
    ) {
        self.id = id
        self.name = name
        self.environmentId = environmentId
        self.hosts = hosts
        self.port = port
        self.token = token
        self.relay = relay
        self.source = source
    }

    init(id: String, name: String? = nil, environmentId: String? = nil, target: PairingTarget, source: Source) {
        self.init(
            id: id, name: name, environmentId: environmentId, hosts: target.hosts, port: target.port,
            token: target.token, relay: target.relay, source: source)
    }

    /// Entries saved before the relay listed machines have no `source`.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        environmentId = try container.decodeIfPresent(String.self, forKey: .environmentId)
        hosts = try container.decode([String].self, forKey: .hosts)
        port = try container.decode(Int.self, forKey: .port)
        token = try container.decode(String.self, forKey: .token)
        relay = try container.decodeIfPresent(String.self, forKey: .relay)
        source = try container.decodeIfPresent(Source.self, forKey: .source) ?? .pairing
    }

    var target: PairingTarget {
        get { PairingTarget(hosts: hosts, port: port, token: token, relay: relay) }
        set {
            hosts = newValue.hosts
            port = newValue.port
            token = newValue.token
            relay = newValue.relay
        }
    }

    static func newServerId() -> String {
        UUID().uuidString.lowercased()
    }

    /// Reads the saved list, dropping each entry that is unreadable or whose pairing no socket can use.
    static func parseList(_ data: Data?) -> [StoredServer] {
        guard let data, let entries = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
        return entries.compactMap { entry in
            // The stored form checks types only; the pairing URL parser also refuses hosts and ports no socket can use.
            guard var server = entry.server, let target = PairingTarget.parse(server.target.url) else { return nil }
            server.target = target
            return server
        }
    }

    /// Adds a pairing, or updates the server it pairs with again: the same relay, or the same port and an address in
    /// common, as after the token was rotated. Returns the list and the id of the server it reaches.
    static func adding(
        _ target: PairingTarget, to servers: [StoredServer], newId: () -> String = newServerId
    ) -> (servers: [StoredServer], id: String) {
        let same = servers.firstIndex { server in
            (target.relay != nil && server.relay == target.relay)
                || (server.port == target.port && server.hosts.contains { target.hosts.contains($0) })
        }
        guard let same else {
            let added = StoredServer(id: newId(), target: target, source: .pairing)
            return (servers + [added], added.id)
        }
        var servers = servers
        servers[same].target = target
        return (servers, servers[same].id)
    }

    private struct Entry: Decodable {
        let server: StoredServer?

        init(from decoder: any Decoder) throws {
            server = try? StoredServer(from: decoder)
        }
    }
}
