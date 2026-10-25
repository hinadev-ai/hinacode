import Foundation

/// The phone's side of the remote protocol, from `src/shared/remote.ts`.
public enum Remote {
    /// Path the phone upgrades to a WebSocket on.
    static let path = "/remote"

    /// Bumped when a frame changes shape, so an old phone app says "update" instead of failing oddly.
    public static let protocolVersion = 1

    /// The listener closes a socket whose unsent output grows past this, so no single answer may be larger.
    public static let slowConsumerBytes = 8 * 1024 * 1024

    /// How long the relay waits behind the direct addresses, so one on this network wins whenever it answers.
    public static let relayDelay: Duration = .milliseconds(500)

    /// While connected through the relay, how often a client checks whether a direct address answers again.
    public static let directCheckInterval: Duration = .seconds(60)

    /// How long that check waits for a direct address to open.
    public static let directCheckTimeout: Duration = .seconds(2)

    /// How long a client waits for the server's `challenge` after its socket opens. Without one, it sends the token
    /// itself only over the relay, which reaches the machine's own hostname over TLS, or to a pairing without a relay,
    /// whose server may predate the challenge. On the direct address of a pairing with a relay, no challenge counts as
    /// a refusal.
    public static let challengeWait: Duration = .seconds(1)
}

/// One socket URL a client dials in a round, and how long after the round starts.
public struct Dial: Hashable, Sendable {
    public enum Route: Hashable, Sendable {
        case direct, relay
    }

    public var url: URL
    public var route: Route
    public var delay: Duration

    public init(url: URL, route: Route, delay: Duration) {
        self.url = url
        self.route = route
        self.delay = delay
    }
}

/// A pairing reaches one desktop on any of `hosts`, tried in order, or from any network through `relay`, the hostname
/// of its Cloudflare tunnel.
public struct PairingTarget: Codable, Hashable, Sendable {
    /// Never empty.
    public var hosts: [String]
    public var port: Int
    public var token: String
    public var relay: String?

    public init(hosts: [String], port: Int, token: String, relay: String?) {
        self.hosts = hosts
        self.port = port
        self.token = token
        self.relay = relay
    }

    /// Reads a pairing URL back, keeping the order of repeated `host`s. Accepts it inside other text, such as the
    /// lines `hinacode serve` prints around it, by reading the first `hinacode://connect?` word. Nil when that word is
    /// missing or is not a complete `hinacode://connect` URL.
    public static func parse(_ text: String) -> PairingTarget? {
        let prefix = Array("hinacode://connect?".utf8)
        guard
            let word = text.split(whereSeparator: \.isWhitespace).first(where: {
                $0.utf8.prefix(prefix.count).map(lowercasedASCII) == prefix
            })
        else { return nil }
        // The scheme is case-insensitive, but `connect` is an opaque host, which URL parsing keeps as written.
        guard word.utf8.dropFirst("hinacode://".utf8.count).starts(with: "connect?".utf8) else { return nil }
        let fields = formFields(word.utf8.dropFirst(prefix.count).prefix { $0 != UInt8(ascii: "#") })
        func first(_ name: String) -> String? { fields.first { $0.name == name }?.value }

        let hosts = fields.filter { $0.name == "host" }.map(\.value)
        guard !hosts.isEmpty, hosts.allSatisfy(isAuthorityOnlyHost) else { return nil }
        guard let token = first("token"), !token.isEmpty, let port = first("port").flatMap(portNumber) else {
            return nil
        }
        let relay = first("relay")
        if let relay, !isRelayHostname(relay) { return nil }
        return PairingTarget(hosts: hosts, port: port, token: token, relay: relay)
    }

    /// The text the pairing QR code carries, as `hinacode://connect?relay=&host=a&host=b&port=&token=`.
    public var url: String {
        var fields = relay.map { [("relay", $0)] } ?? []
        fields += hosts.map { ("host", $0) }
        fields += [("port", String(port)), ("token", token)]
        return "hinacode://connect?"
            + fields.map { "\(Self.formEncoded($0))=\(Self.formEncoded($1))" }.joined(separator: "&")
    }

    /// What a client dials to reach this pairing: every direct address at once, then the relay after
    /// `Remote.relayDelay`. The first socket to open wins and the others close, so the pairing token goes to that
    /// socket only.
    public var dialPlan: [Dial] {
        let direct = hosts.compactMap { host in
            Self.socketURL(host: host, port: port).map { Dial(url: $0, route: .direct, delay: .zero) }
        }
        guard let relay, let url = URL(string: "wss://\(relay)\(Remote.path)") else { return direct }
        // Cloudflare's edge serves a tunnel on 443 only.
        return direct + [Dial(url: url, route: .relay, delay: Remote.relayDelay)]
    }

    private static func socketURL(host: String, port: Int) -> URL? {
        URL(string: "ws://\(host.contains(":") ? "[\(host)]" : host):\(port)\(Remote.path)")
    }

    private static func isAuthorityOnlyHost(_ host: String) -> Bool {
        !host.isEmpty && !host.contains { $0.isWhitespace || "/?#@[]\\".contains($0) }
            && (!host.contains(":") || isIPv6Address(host)) && socketURL(host: host, port: 1) != nil
    }

    private static func isIPv6Address(_ host: String) -> Bool {
        var address = in6_addr()
        return inet_pton(AF_INET6, host, &address) == 1
    }

    private static func isRelayHostname(_ relay: String) -> Bool {
        let labels = relay.utf8.split(separator: UInt8(ascii: "."), omittingEmptySubsequences: false)
        return labels.count >= 2
            && labels.allSatisfy { label in
                !label.isEmpty && label.allSatisfy { isASCIIAlphanumeric($0) || $0 == UInt8(ascii: "-") }
            }
    }

    /// Reads `port` the way JavaScript's `Number` does for the forms a port takes, then requires an integer port.
    private static func portNumber(_ text: String) -> Int? {
        guard let number = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)),
            let port = Int(exactly: number), (1...65535).contains(port)
        else { return nil }
        return port
    }

    /// The name and value pairs of an `application/x-www-form-urlencoded` query, in order.
    private static func formFields(_ query: some Collection<UInt8>) -> [(name: String, value: String)] {
        query.split(separator: UInt8(ascii: "&")).map { field in
            let parts = field.split(separator: UInt8(ascii: "="), maxSplits: 1, omittingEmptySubsequences: false)
            return (formDecoded(parts[0]), parts.count > 1 ? formDecoded(parts[1]) : "")
        }
    }

    private static func formDecoded(_ bytes: some Collection<UInt8>) -> String {
        let bytes = Array(bytes)
        var decoded: [UInt8] = []
        var index = 0
        while index < bytes.count {
            if bytes[index] == UInt8(ascii: "%"), index + 2 < bytes.count,
                let high = hexValue(bytes[index + 1]), let low = hexValue(bytes[index + 2])
            {
                decoded.append(high << 4 | low)
                index += 3
            } else {
                decoded.append(bytes[index] == UInt8(ascii: "+") ? UInt8(ascii: " ") : bytes[index])
                index += 1
            }
        }
        return String(decoding: decoded, as: UTF8.self)
    }

    private static func formEncoded(_ text: String) -> String {
        var encoded = ""
        for byte in text.utf8 {
            if byte == UInt8(ascii: " ") {
                encoded += "+"
            } else if isASCIIAlphanumeric(byte) || "*-._".utf8.contains(byte) {
                encoded.unicodeScalars.append(Unicode.Scalar(byte))
            } else {
                encoded += String(format: "%%%02X", byte)
            }
        }
        return encoded
    }

    private static func hexValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): byte - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): byte - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): byte - UInt8(ascii: "A") + 10
        default: nil
        }
    }

    private static func isASCIIAlphanumeric(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) || (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte)
            || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte)
    }

    private static func lowercasedASCII(_ byte: UInt8) -> UInt8 {
        (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte) ? byte + 32 : byte
    }
}
