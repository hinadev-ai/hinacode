import Foundation
import Observation

/// The phone's own settings. The desktop's settings stay on the desktop.
public struct PhonePreferences: Codable, Equatable, Sendable {
    public enum Appearance: String, Codable, CaseIterable, Sendable {
        case system, light, dark
    }

    public enum HomeTab: String, Codable, CaseIterable, Sendable {
        case inbox, threads, archived
    }

    public struct Notifications: Codable, Equatable, Sendable {
        public var completed: Bool
        public var needsInput: Bool
        public var failed: Bool

        public init(completed: Bool, needsInput: Bool, failed: Bool) {
            self.completed = completed
            self.needsInput = needsInput
            self.failed = failed
        }
    }

    public var appearance: Appearance
    public var notifications: Notifications
    public var homeTab: HomeTab
    /// Whether the thread list beside the open thread is hidden, in a landscape split.
    public var sidebarHidden: Bool

    public static let `default` = PhonePreferences(
        appearance: .system, notifications: .init(completed: true, needsInput: true, failed: true), homeTab: .inbox,
        sidebarHidden: false)

    /// The JSON the Expo app kept under the same key.
    static let storageKey = "hinacode.preferences"

    public init(appearance: Appearance, notifications: Notifications, homeTab: HomeTab, sidebarHidden: Bool) {
        self.appearance = appearance
        self.notifications = notifications
        self.homeTab = homeTab
        self.sidebarHidden = sidebarHidden
    }

    /// Keys an older app never wrote take their defaults. An invalid value or unreadable JSON gives all the defaults.
    static func parse(_ raw: String?) -> PhonePreferences {
        guard let raw else { return .default }
        return (try? JSONDecoder().decode(PhonePreferences.self, from: Data(raw.utf8))) ?? .default
    }

    private enum CodingKeys: String, CodingKey {
        case appearance, notifications, homeTab, sidebarHidden
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func decode<Value: Decodable>(_ key: CodingKeys, or fallback: Value) throws -> Value {
            container.contains(key) ? try container.decode(Value.self, forKey: key) : fallback
        }
        let fallback = Self.default
        appearance = try decode(.appearance, or: fallback.appearance)
        notifications = try decode(.notifications, or: fallback.notifications)
        homeTab = try decode(.homeTab, or: fallback.homeTab)
        sidebarHidden = try decode(.sidebarHidden, or: fallback.sidebarHidden)
    }
}

/// The phone's preferences, read at launch and saved in `UserDefaults` on every change.
@MainActor
@Observable
public final class PreferencesStore {
    public var appearance: PhonePreferences.Appearance { didSet { save() } }
    public var notifications: PhonePreferences.Notifications { didSet { save() } }
    public var homeTab: PhonePreferences.HomeTab { didSet { save() } }
    public var sidebarHidden: Bool { didSet { save() } }

    @ObservationIgnored private let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
        let stored = PhonePreferences.parse(defaults.string(forKey: PhonePreferences.storageKey))
        appearance = stored.appearance
        notifications = stored.notifications
        homeTab = stored.homeTab
        sidebarHidden = stored.sidebarHidden
    }

    private func save() {
        let preferences = PhonePreferences(
            appearance: appearance, notifications: notifications, homeTab: homeTab, sidebarHidden: sidebarHidden)
        guard let json = try? JSONEncoder().encode(preferences) else { return }
        defaults.set(String(decoding: json, as: UTF8.self), forKey: PhonePreferences.storageKey)
    }
}
