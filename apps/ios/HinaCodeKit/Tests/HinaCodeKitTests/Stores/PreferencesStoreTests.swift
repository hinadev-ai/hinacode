import Foundation
import Testing

@testable import HinaCodeKit

@Suite("parsePreferences")
struct PhonePreferencesParseTests {
    @Test("uses the defaults before anything was stored")
    func nothingStored() {
        #expect(PhonePreferences.parse(nil) == .default)
    }

    @Test("reads what the app stored")
    func readsStored() {
        let stored = """
            {"appearance":"dark","notifications":{"completed":false,"needsInput":true,"failed":true},\
            "homeTab":"threads","sidebarHidden":true}
            """
        #expect(
            PhonePreferences.parse(stored)
                == PhonePreferences(
                    appearance: .dark, notifications: .init(completed: false, needsInput: true, failed: true),
                    homeTab: .threads, sidebarHidden: true))
    }

    @Test("fills keys an older app never wrote")
    func fillsMissingKeys() {
        var expected = PhonePreferences.default
        expected.appearance = .light
        #expect(PhonePreferences.parse(#"{"appearance":"light"}"#) == expected)
    }

    @Test("falls back to the defaults for unreadable data")
    func unreadable() {
        #expect(PhonePreferences.parse("{not json") == .default)
        #expect(PhonePreferences.parse(#"{"appearance":"sepia"}"#) == .default)
    }
}

@MainActor
@Suite("PreferencesStore")
struct PreferencesStoreTests {
    @Test("keeps a change across launches")
    func persists() {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let store = PreferencesStore(defaults: defaults)
        #expect(store.appearance == .system)
        store.appearance = .dark
        store.notifications.failed = false

        let relaunched = PreferencesStore(defaults: defaults)
        #expect(relaunched.appearance == .dark)
        #expect(relaunched.notifications == .init(completed: true, needsInput: true, failed: false))
        #expect(relaunched.homeTab == .inbox)
    }
}
