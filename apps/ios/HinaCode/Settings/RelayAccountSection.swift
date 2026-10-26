import HinaCodeKit
import SwiftUI

extension RelayError {
    /// The copy for why talking to the relay failed.
    var localized: LocalizedStringResource {
        switch self {
        case .unreachable: .mobileRelayUnreachable
        case .badStatus(let status): .mobileRelayBadStatus(String(status))
        case .badAnswer: .mobileRelayBadAnswer
        case .tokenRefused: .mobileRelayTokenRefused
        case .tokenRotated: .mobileRelayTokenRotated
        case .syncFailed(let inner): .mobileRelaySyncFailed(String(localized: inner.localized))
        }
    }
}

/// Signs in to the relay with the owner token, so every machine shown on the relay page appears here. Form content:
/// Settings and the pairing screen both place it inside their forms.
struct RelayAccountSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let serviceUrl = model.relayAccount.serviceUrl {
            RelayStatusSections(serviceUrl: serviceUrl)
            if model.relayAccount.unauthorized {
                Section {
                    RelaySignInForm(initialUrl: serviceUrl)
                } header: {
                    Text(.mobileRelaySignIn)
                }
            }
        } else {
            Section {
                RelaySignInForm(initialUrl: Self.defaultServiceUrl)
            } header: {
                Text(.mobileRelayTitle)
            } footer: {
                Text(.mobileRelayFootnote)
            }
        }
    }

    private static let defaultServiceUrl = "https://relay.hinacode.app"
}

/// The signed-in relay: where it is, what the last sync found, and the way out.
private struct RelayStatusSections: View {
    @Environment(AppModel.self) private var model

    let serviceUrl: String

    @State private var confirmingSignOut = false

    private var account: RelayAccountStore { model.relayAccount }

    var body: some View {
        if let error = account.error {
            Section {
                Label(error.localized, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Palette.destructive)
            }
        }

        Section {
            LabeledContent {
                Text(verbatim: host)
                    .lineLimit(1)
            } label: {
                Label(.mobileRelayService, systemImage: "powerplug")
            }

            LabeledContent {
                if let machines = account.machines {
                    Text(verbatim: String(machines))
                }
            } label: {
                Label(.mobileRelayMachines, systemImage: "desktopcomputer")
            }

            LabeledContent {
                if let syncedAt = account.syncedAt {
                    TimelineView(.periodic(from: Date(), by: 30)) { context in
                        RelativeTimeText(iso: syncedAt, now: context.date)
                    }
                } else {
                    Text(.mobileRelayNever)
                }
            } label: {
                Label(.mobileRelayLastSync, systemImage: "clock")
            }

            Button(action: sync) {
                Label {
                    Text(.mobileRelaySyncNow)
                } icon: {
                    if account.syncing {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .disabled(account.syncing)

            Button(.mobileRelaySignOut, systemImage: "rectangle.portrait.and.arrow.right") {
                confirmingSignOut = true
            }
        } header: {
            Text(.mobileRelayTitle)
        } footer: {
            Text(.mobileRelaySignedInFootnote)
        }
        .confirmationDialog(Text(.mobileRelaySignOutTitle), isPresented: $confirmingSignOut) {
            Button(.mobileRelaySignOut, role: .destructive) {
                Task { await account.signOut() }
            }
            Button(.mobileSettingsCancel, role: .cancel) {}
        } message: {
            Text(.mobileRelaySignOutMessage)
        }
    }

    private var host: String {
        URL(string: serviceUrl)?.host() ?? serviceUrl
    }

    private func sync() {
        Task { await account.sync() }
    }
}

/// Saves the account only once the relay accepts the owner token.
private struct RelaySignInForm: View {
    @Environment(AppModel.self) private var model

    @State private var serviceUrl: String
    @State private var ownerToken = ""
    @State private var busy = false
    @State private var error: RelayError?

    init(initialUrl: String) {
        // One-time seed: what the form starts from, not a value it tracks.
        _serviceUrl = State(initialValue: initialUrl)
    }

    var body: some View {
        TextField(text: $serviceUrl) {
            Label(.mobileRelayServiceUrl, systemImage: "link")
        }
        .font(.system(.callout, design: .monospaced))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .keyboardType(.URL)
        .submitLabel(.next)

        SecureField(text: $ownerToken) {
            Label(.mobileRelayOwnerToken, systemImage: "key")
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.go)
        .onSubmit(submit)

        if let error {
            Label(error.localized, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Palette.destructive)
        }

        Button(action: submit) {
            Label {
                Text(.mobileRelaySignIn)
            } icon: {
                if busy {
                    ProgressView()
                } else {
                    Image(systemName: "lock.shield")
                }
            }
        }
        .disabled(busy || trimmed(serviceUrl).isEmpty || trimmed(ownerToken).isEmpty)
        .sensoryFeedback(.error, trigger: error) { _, now in now != nil }
    }

    private func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func submit() {
        guard !busy, !trimmed(serviceUrl).isEmpty, !trimmed(ownerToken).isEmpty else { return }
        busy = true
        error = nil
        let url = trimmed(serviceUrl)
        let token = trimmed(ownerToken)
        Task {
            error = await model.relayAccount.signIn(serviceUrl: url, ownerToken: token)
            busy = false
        }
    }
}
