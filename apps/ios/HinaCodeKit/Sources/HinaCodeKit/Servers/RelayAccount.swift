import Foundation

/// The relay this phone signed in to. The owner token lists every machine the owner shows on their devices.
public struct RelayAccount: Codable, Hashable, Sendable {
    public var serviceUrl: String
    public var ownerToken: String

    public init(serviceUrl: String, ownerToken: String) {
        self.serviceUrl = serviceUrl
        self.ownerToken = ownerToken
    }
}
