import CryptoKit
import Foundation

/// Proofs that a client and a server hold the same pairing token, so the token itself never crosses the wire. The
/// server sends a nonce first; the client answers with `client` and a nonce of its own; the server's `ready` carries
/// `server`. A stranger at the machine's address learns neither the token nor a proof it can reuse.
public enum PairingProof {
    public static func client(token: String, serverNonce: String, clientNonce: String) -> String {
        prove(token: token, label: "client", serverNonce, clientNonce)
    }

    public static func server(token: String, clientNonce: String, serverNonce: String) -> String {
        prove(token: token, label: "server", clientNonce, serverNonce)
    }

    /// 32 random bytes in lowercase hex.
    public static func newNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        return hex((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }

    private static func prove(token: String, label: String, _ first: String, _ second: String) -> String {
        let message = Data("hinacode \(label)\n\(first)\n\(second)".utf8)
        return hex(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: Data(token.utf8))))
    }

    private static func hex(_ bytes: some Sequence<UInt8>) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}
