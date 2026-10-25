import SwiftUI

/// Placeholder for Settings, built by the settings unit.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {}
                .navigationTitle(.mobileHomeSettings)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(.mobileSettingsDone) { dismiss() }
                            .accessibilityIdentifier("settings-done")
                    }
                }
        }
    }
}
