import HinaCodeKit
import SwiftUI

/// Pairing until a desktop or a cloud answers, then the split view.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.hub.paired {
            MainView()
        } else {
            PairingScreen()
        }
    }
}

/// The first-run screen: the pairing form, with the relay sign-in one level down for those who use a relay.
struct PairingScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            PairingForm(refusal: refusal, onPair: { _ = model.hub.pair($0) }) {
                Section {
                    NavigationLink {
                        Form {
                            Group {
                                RelayAccountSection()
                            }
                            .listRowBackground(Palette.background)
                        }
                        .paletteList()
                        .navigationTitle(.mobileRelayTitle)
                    } label: {
                        Label(.mobilePairingRelay, systemImage: "cloud")
                    }
                }
            }
        }
    }

    /// Why the first server that refused us did, while nothing else is paired.
    private var refusal: String? {
        model.hub.servers.first { $0.error != nil }?.error
    }
}

/// Adds another desktop or cloud while paired.
struct AddServerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PairingForm {
                _ = model.hub.pair($0)
                dismiss()
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .cancel) { dismiss() }
                }
            }
        }
    }
}
