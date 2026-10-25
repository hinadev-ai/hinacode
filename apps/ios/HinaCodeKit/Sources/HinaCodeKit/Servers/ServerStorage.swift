import Foundation
import Security

/// What the phone keeps between launches about the desktops it reaches: the paired servers and the relay account.
/// Both hold tokens.
@MainActor
public protocol ServerStorage {
    func loadServers() -> [StoredServer]
    func saveServers(_ servers: [StoredServer])
    func loadRelayAccount() -> RelayAccount?
    /// Nil deletes the saved account.
    func saveRelayAccount(_ account: RelayAccount?)
}

/// Keeps each value in its own Keychain item, readable after the first unlock and never restored to another device.
public struct KeychainServerStorage: ServerStorage {
    private let servers = KeychainItem(account: "servers")
    private let relayAccount = KeychainItem(account: "relayAccount")

    public init() {}

    public func loadServers() -> [StoredServer] {
        StoredServer.parseList(servers.read())
    }

    public func saveServers(_ list: [StoredServer]) {
        servers.write(try! JSONEncoder().encode(list))
    }

    public func loadRelayAccount() -> RelayAccount? {
        relayAccount.read().flatMap { try? JSONDecoder().decode(RelayAccount.self, from: $0) }
    }

    public func saveRelayAccount(_ account: RelayAccount?) {
        if let account {
            relayAccount.write(try! JSONEncoder().encode(account))
        } else {
            relayAccount.delete()
        }
    }
}

/// Keeps everything in memory, for previews and tests.
@MainActor
public final class MemoryServerStorage: ServerStorage {
    public var servers: [StoredServer]
    public var relayAccount: RelayAccount?

    public init(servers: [StoredServer] = [], relayAccount: RelayAccount? = nil) {
        self.servers = servers
        self.relayAccount = relayAccount
    }

    public func loadServers() -> [StoredServer] { servers }
    public func saveServers(_ servers: [StoredServer]) { self.servers = servers }
    public func loadRelayAccount() -> RelayAccount? { relayAccount }
    public func saveRelayAccount(_ account: RelayAccount?) { relayAccount = account }
}

/// One generic password of this app.
private struct KeychainItem {
    let account: String

    private var query: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "app.hinacode.ios",
            kSecAttrAccount: account,
            kSecUseDataProtectionKeychain: true,
        ]
    }

    func read() -> Data? {
        var query = query
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    func write(_ data: Data) {
        let attributes: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
    }

    func delete() {
        SecItemDelete(query as CFDictionary)
    }
}
