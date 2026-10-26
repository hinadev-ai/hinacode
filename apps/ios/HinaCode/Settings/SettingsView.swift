import HinaCodeKit
import SwiftUI
import UserNotifications

/// Everything adjustable: this phone, each server's desktop settings, the servers themselves, the relay account.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    PhoneSettingsSections()
                    DesktopSettingsSections()
                    ServersSection()
                    RelayAccountSection()

                    Section {
                        Label(.mobileSettingsVersion(version), systemImage: "iphone")
                    } header: {
                        Text(.mobileSettingsAbout)
                    }
                }
                .listRowBackground(Palette.background)
            }
            .paletteList()
            .navigationTitle(.mobileHomeSettings)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(.mobileSettingsDone) { dismiss() }
                        .accessibilityIdentifier("settings-done")
                }
            }
        }
    }

    private var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }
}

extension ServerHub.Server {
    /// The name Settings shows, before the first handshake names the server.
    var settingsName: String { name ?? hosts.first ?? "" }
}

/// Appearance and notifications, kept on this phone.
private struct PhoneSettingsSections: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    @State private var authorization: UNAuthorizationStatus?
    @State private var asking = false

    var body: some View {
        Section {
            Picker(selection: Bindable(model.preferences).appearance) {
                Label(.mobileSettingsAppearanceSystem, systemImage: "circle.lefthalf.filled")
                    .tag(PhonePreferences.Appearance.system)
                Label(.mobileSettingsAppearanceLight, systemImage: "sun.max")
                    .tag(PhonePreferences.Appearance.light)
                Label(.mobileSettingsAppearanceDark, systemImage: "moon")
                    .tag(PhonePreferences.Appearance.dark)
            } label: {
                Label(.mobileSettingsAppearance, systemImage: "circle.lefthalf.filled")
            }
            .pickerStyle(.menu)
        } header: {
            Text(.mobileSettingsPhone)
        }

        Section {
            Toggle(isOn: Bindable(model.preferences).notifications.completed) {
                Label(.mobileSettingsNotifyCompleted, systemImage: "checkmark.circle")
            }
            Toggle(isOn: Bindable(model.preferences).notifications.needsInput) {
                Label(.mobileSettingsNotifyNeedsInput, systemImage: "questionmark.circle")
            }
            Toggle(isOn: Bindable(model.preferences).notifications.failed) {
                Label(.mobileSettingsNotifyFailed, systemImage: "exclamationmark.circle")
            }
            permissionRows
        } header: {
            Text(.mobileSettingsNotifications)
        } footer: {
            Text(.mobileSettingsNotificationsFootnote)
        }
        .task { await refreshPermission() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refreshPermission() } }
        }
    }

    @ViewBuilder private var permissionRows: some View {
        switch authorization {
        case .notDetermined:
            Button(action: ask) {
                Label {
                    Text(.mobileSettingsNotificationsAllow)
                } icon: {
                    if asking {
                        ProgressView()
                    } else {
                        Image(systemName: "bell.badge")
                    }
                }
            }
            .disabled(asking)
        case .denied:
            Label(.mobileSettingsNotificationsDenied, systemImage: "bell.slash")
                .foregroundStyle(Palette.attention)
            Button(.mobileSettingsOpenSettings, systemImage: "gearshape") {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
        default:
            EmptyView()
        }
    }

    private func refreshPermission() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    private func ask() {
        asking = true
        Task {
            _ = try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            await refreshPermission()
            asking = false
        }
    }
}
