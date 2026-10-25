import CryptoKit
import Foundation
import HinaCodeKit
import Testing

private func hmac(_ key: String, _ message: String) -> String {
    HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: Data(key.utf8)))
        .map { String(format: "%02x", $0) }.joined()
}

@Suite("token proofs")
struct PairingProofTests {
    @Test("are HMAC-SHA256 of both nonces, keyed by the token")
    func layout() {
        #expect(
            PairingProof.client(token: "token", serverNonce: "server-nonce", clientNonce: "client-nonce")
                == hmac("token", "hinacode client\nserver-nonce\nclient-nonce"))
        #expect(
            PairingProof.server(token: "token", clientNonce: "client-nonce", serverNonce: "server-nonce")
                == hmac("token", "hinacode server\nclient-nonce\nserver-nonce"))
    }

    @Test("match proof.ts byte for byte")
    func pinnedVector() {
        // Computed by running src/shared/proof.ts in node.
        #expect(
            PairingProof.client(token: "t/k+n é", serverNonce: "server-nonce", clientNonce: "client-nonce")
                == "63dc5000295786da481c19b8050d842b4bf567edc1b7630aa88d907e25d5c1a6")
        #expect(
            PairingProof.server(token: "t/k+n é", clientNonce: "client-nonce", serverNonce: "server-nonce")
                == "f8eb1a998e27956d810d4315f88081c71effbbd6f1d5a8859d13c550d94255ac")
    }

    @Test("differ by side, so a client proof never passes as the server's")
    func sides() {
        #expect(
            PairingProof.client(token: "token", serverNonce: "a", clientNonce: "b")
                != PairingProof.server(token: "token", clientNonce: "a", serverNonce: "b"))
    }

    @Test("change with the token and with each nonce")
    func inputs() {
        let proof = PairingProof.client(token: "token", serverNonce: "s", clientNonce: "c")
        #expect(PairingProof.client(token: "other", serverNonce: "s", clientNonce: "c") != proof)
        #expect(PairingProof.client(token: "token", serverNonce: "s2", clientNonce: "c") != proof)
        #expect(PairingProof.client(token: "token", serverNonce: "s", clientNonce: "c2") != proof)
    }

    @Test("makes fresh 32-byte nonces")
    func nonces() {
        let nonce = PairingProof.newNonce()
        #expect(nonce.wholeMatch(of: /[0-9a-f]{64}/) != nil)
        #expect(PairingProof.newNonce() != nonce)
    }
}
