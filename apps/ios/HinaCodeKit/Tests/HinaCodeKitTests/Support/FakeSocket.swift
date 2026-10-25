import Foundation
import Testing

@testable import HinaCodeKit

/// A client frame as the desktop reads it.
struct SentFrame: Decodable, Equatable {
    var type: String
    var id: Int? = nil
    var method: String? = nil
    var payload: JSONValue? = nil
    var key: String? = nil
    var nonce: String? = nil
    var proof: String? = nil
    var token: String? = nil

    static func call(_ id: Int, _ method: String, payload: JSONValue? = nil, key: String? = nil) -> Self {
        SentFrame(type: "call", id: id, method: method, payload: payload, key: key)
    }

    static func auth(token: String) -> Self { SentFrame(type: "auth", token: token) }

    var isProof: Bool { type == "auth" && nonce != nil && proof != nil && token == nil }
}

/// A socket and the server behind it, which holds `token`.
@MainActor
final class FakeSocket: SocketLike {
    nonisolated static let allFeatures = ["heartbeat", "call-keys", "terminal-attach"]

    var onOpen: (() -> Void)?
    var onMessage: ((IncomingFrame) -> Void)?
    var onClose: ((Int) -> Void)?
    let url: String
    private(set) var texts: [String] = []
    private(set) var closed = false
    private let token: String
    private var serverNonce: String?
    /// Away from home a direct address may be a stranger's HinaCode, so only a pairing without a relay ever sends it
    /// the token.
    private let mustNotSeeToken: Bool

    init(url: URL, token: String, mustNotSeeToken: Bool = false) {
        self.url = url.absoluteString
        self.token = token
        self.mustNotSeeToken = mustNotSeeToken
    }

    var sent: [SentFrame] { texts.map { try! JSONDecoder().decode(SentFrame.self, from: Data($0.utf8)) } }

    func send(_ text: String) {
        if mustNotSeeToken { #expect(!text.contains(token), "sent the token to \(url)") }
        texts.append(text)
    }

    func close() { closed = true }

    func open() { onOpen?() }

    func challenge(_ nonce: String = "server-nonce") {
        serverNonce = nonce
        receive(#"{"type":"challenge","nonce":"\#(nonce)"}"#)
    }

    /// Proves `token` back when the client proved it, as a current server does; an older one omits the proof.
    func ready(
        _ features: [String] = allFeatures, version: Int = 1, environment: ServerIdentity? = nil, relay: String? = nil
    ) {
        let list = features.map { #""\#($0)""# }.joined(separator: ",")
        var extra = ""
        if let environment {
            extra += #","environment":{"id":"\#(environment.id)","name":"\#(environment.name)"}"#
        }
        if let relay { extra += #","relay":"\#(relay)""# }
        if let nonce = sent.first(where: { $0.type == "auth" })?.nonce, let serverNonce {
            extra += #","proof":"\#(PairingProof.server(token: token, clientNonce: nonce, serverNonce: serverNonce))""#
        }
        receive(#"{"type":"ready","version":\#(version),"features":[\#(list)]\#(extra)}"#)
    }

    /// Opens, challenges and answers ready, as a current server does.
    func handshake(_ features: [String] = allFeatures, environment: ServerIdentity? = nil, relay: String? = nil) {
        open()
        challenge()
        ready(features, environment: environment, relay: relay)
    }

    func receive(_ text: String) { onMessage?(IncomingFrame(text: text)) }

    func result(_ id: Int, _ result: String = "null") {
        receive(#"{"type":"result","id":\#(id),"envelope":{"result":\#(result)}}"#)
    }

    /// Answers every call to `method` so far with the JSON `result`.
    func answer(_ method: String, _ result: String) {
        for call in calls(method) { self.result(call.id!, result) }
    }

    func drop(_ code: Int = 1006) { onClose?(code) }

    func calls() -> [SentFrame] { sent.filter { $0.type == "call" } }

    func calls(_ method: String) -> [SentFrame] { calls().filter { $0.method == method } }

    func pings() -> [SentFrame] { sent.filter { $0.type == "ping" } }
}
