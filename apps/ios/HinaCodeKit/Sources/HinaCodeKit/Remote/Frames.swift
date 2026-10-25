import Foundation

/// Which HinaCode answered a pairing, so a desktop paired twice keeps one entry.
public struct ServerIdentity: Codable, Hashable, Sendable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// Phone -> desktop. The first frame on a socket must be `auth`: proof of the token for the server's `challenge`, or
/// the token itself for a server that predates the challenge.
enum ClientFrame {
    case proof(nonce: String, proof: String)
    case token(String)
    /// `payload` is JSON, absent for methods that take nothing.
    case call(id: Int, method: String, payload: Data?, key: String?)
    case ping(at: Int)

    var text: String {
        let fields: [(String, String?)] =
            switch self {
            case .proof(let nonce, let proof): [("type", json("auth")), ("nonce", json(nonce)), ("proof", json(proof))]
            case .token(let token): [("type", json("auth")), ("token", json(token))]
            case .call(let id, let method, let payload, let key):
                [
                    ("type", json("call")), ("id", String(id)), ("method", json(method)),
                    ("payload", payload.map { String(decoding: $0, as: UTF8.self) }), ("key", key.map(json)),
                ]
            case .ping(let at): [("type", json("ping")), ("at", String(at))]
            }
        let members = fields.compactMap { name, value in value.map { "\(json(name)):\($0)" } }
        return "{\(members.joined(separator: ","))}"
    }

    private func json(_ string: String) -> String {
        String(decoding: try! JSONEncoder().encode(string), as: UTF8.self)
    }
}

/// Desktop -> phone, decoded from one text message.
public enum IncomingFrame: Hashable, Sendable {
    public struct Ready: Hashable, Sendable {
        public var version: Int
        /// Older desktops omit it.
        public var environment: ServerIdentity?
        public var features: [String]
        /// The desktop's tunnel hostname, nil when it has none.
        public var relay: String?
        /// Answers a client that proved its token, so the client knows it reached the machine and not a stranger.
        public var proof: String?

        public init(
            version: Int, environment: ServerIdentity? = nil, features: [String], relay: String? = nil,
            proof: String? = nil
        ) {
            self.version = version
            self.environment = environment
            self.features = features
            self.relay = relay
            self.proof = proof
        }
    }

    /// The first frame a server sends.
    case challenge(nonce: String)
    case ready(Ready)
    /// The answer to one call. `frame` is the whole message, for `ResultEnvelope` to decode with the method's answer.
    case result(id: Int, frame: Data)
    case event(PushEvent)
    case pong
    /// Not JSON, or not a frame this build reads. The transport ignores it.
    case unreadable

    /// Decodes without touching any actor, so a socket can call it off the main actor.
    public init(text: String) {
        let data = Data(text.utf8)
        switch try? JSONDecoder().decode(DecodedFrame.self, from: data) {
        case .challenge(let nonce): self = .challenge(nonce: nonce)
        case .ready(let ready): self = .ready(ready)
        case .result(let id): self = .result(id: id, frame: data)
        case .event(let event): self = .event(event)
        case .pong: self = .pong
        case nil: self = .unreadable
        }
    }
}

/// A result frame's answer: the method's response, or the error its handler failed with.
public struct ResultEnvelope<Response: Decodable>: Decodable {
    public let result: Result<Response, RpcError>

    private enum FrameKeys: String, CodingKey {
        case envelope
    }

    private enum EnvelopeKeys: String, CodingKey {
        case error, result
    }

    private struct Failure: Decodable {
        let tag: String
        let message: String
    }

    public init(from decoder: any Decoder) throws {
        let envelope = try decoder.container(keyedBy: FrameKeys.self)
            .nestedContainer(keyedBy: EnvelopeKeys.self, forKey: .envelope)
        if let failure = try? envelope.decode(Failure.self, forKey: .error) {
            result = .failure(RpcError(failure.tag, failure.message))
        } else if let none = NoPayload() as? Response {
            // A method that returns nothing answers `{}`, since JSON drops an undefined `result`.
            result = .success(none)
        } else {
            result = .success(try Response(from: envelope.superDecoder(forKey: .result)))
        }
    }
}

/// `ServerFrame` from `remote.ts`. An optional key that is present must hold its type, as Effect Schema's
/// `optionalKey` requires, so `null` there makes the frame unreadable.
private enum DecodedFrame: Decodable {
    case challenge(String)
    case ready(IncomingFrame.Ready)
    case result(Int)
    case event(PushEvent)
    case pong

    private enum Keys: String, CodingKey {
        case type, nonce, version, environment, features, relay, proof, id, envelope, event, at
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        func optional<Value: Decodable>(_ key: Keys) throws -> Value? {
            container.contains(key) ? try container.decode(Value.self, forKey: key) : nil
        }
        switch try container.decode(String.self, forKey: .type) {
        case "challenge":
            self = .challenge(try container.decode(String.self, forKey: .nonce))
        case "ready":
            self = .ready(
                IncomingFrame.Ready(
                    version: try container.decode(Int.self, forKey: .version),
                    environment: try optional(.environment),
                    features: try optional(.features) ?? [],
                    relay: try optional(.relay),
                    proof: try optional(.proof)))
        case "result":
            _ = try container.nestedContainer(keyedBy: Keys.self, forKey: .envelope)
            self = .result(try container.decode(Int.self, forKey: .id))
        case "event":
            self = .event(try container.decode(PushEvent.self, forKey: .event))
        case "pong":
            _ = try container.decode(Double.self, forKey: .at)
            self = .pong
        case let type:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container, debugDescription: "Unknown frame type \(type)")
        }
    }
}
