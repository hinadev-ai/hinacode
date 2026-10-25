import Foundation

/// The payload of a method that takes nothing, or the answer of one that returns nothing.
public struct NoPayload: Codable, Hashable, Sendable {
    public init() {}
}

/// Keys of an object with no properties.
struct NoKeys: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { nil }
    init?(intValue: Int) { nil }
}

/// A value the schema leaves open, such as a tool call's input.
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// What an id in a payload names, for finding which server owns it. Mirrors `src/shared/routes.ts`.
public enum Entity: String, Hashable, Sendable {
    case thread, project, worktree, terminal, automation, request, root, stream
}

/// Where a call goes when several servers are paired: every server with the lists concatenated, the server that
/// owns the id at `payload[key]`, or the server the caller names.
public enum Route: Hashable, Sendable {
    case all
    case named
    case owner(Entity, key: String)
}

/// One desktop method: its name, whether it changes state, its route, and the types it is sent and answers.
public struct Method<Request: Codable & Sendable, Response: Codable & Sendable>: Sendable {
    public let name: String
    /// Changes state on the desktop, so a retried call carries a key the desktop deduplicates by.
    public let mutation: Bool
    public let route: Route

    init(_ name: String, mutation: Bool, route: Route) {
        self.name = name
        self.mutation = mutation
        self.route = route
    }
}
