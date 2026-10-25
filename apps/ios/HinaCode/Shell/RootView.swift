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

/// The first-run screen: the pairing form with the relay sign-in as its footer.
struct PairingScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            PairingForm(refusal: refusal, onPair: { _ = model.hub.pair($0) }) {
                RelayAccountSection()
            }
            .navigationTitle(.mobileConnectTitle)
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
            .navigationTitle(.mobileConnectTitle)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .cancel) { dismiss() }
                }
            }
        }
    }
}
