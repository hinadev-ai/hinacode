import AVFoundation
import HinaCodeKit
import SwiftUI

/// Pairs with a desktop or a cloud from its QR code or its pairing URL. Used by the first-run screen and by Add server.
struct PairingForm<Footer: View>: View {
    /// Why the last pairing was refused, shown above the form.
    var refusal: String?
    let onPair: (PairingTarget) -> Void
    @ViewBuilder var footer: Footer

    @State private var text = ""
    @State private var invalid = false
    @State private var scanning = false
    @State private var cameraDenied = false

    var body: some View {
        Form {
            Section {
                Label {
                    Text(.mobilePairingLead)
                        .foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "iphone.and.arrow.left.and.arrow.right")
                        .foregroundStyle(.tint)
                }
                .labelStyle(PairingLeadLabelStyle())
            }

            if let refusal {
                Section {
                    Label(refusal, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                }
            }

            if PairingScanner.isSupported {
                Section {
                    Button(.mobilePairingScan, systemImage: "qrcode.viewfinder", action: scan)
                        .accessibilityIdentifier("pairing-scan")
                } footer: {
                    if cameraDenied {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(.mobilePairingCameraDenied)
                            Button(.mobilePairingOpenSettings, action: openSettings)
                        }
                    }
                }
            }

            Section {
                TextField(
                    text: $text, prompt: Text(verbatim: "hinacode://connect?host=…&port=…&token=…"), axis: .vertical
                ) {
                    Text(.mobilePairingUrl)
                }
                .font(.system(.callout, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .lineLimit(2...6)
                .submitLabel(.go)
                .onSubmit(submit)
                .onChange(of: text) { invalid = false }
                .accessibilityIdentifier("pairing-url")

                PasteButton(payloadType: String.self) { strings in
                    text = strings.first ?? ""
                    submit()
                }
            } header: {
                Text(.mobilePairingUrl)
            } footer: {
                if invalid {
                    Text(.mobilePairingInvalid)
                        .foregroundStyle(.red)
                        .accessibilityAddTraits(.isStaticText)
                }
            }

            Section {
                Button(.mobilePairingConnect, action: submit)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("pairing-connect")
            }

            footer
        }
        .fullScreenCover(isPresented: $scanning) {
            ScannerScreen { code in
                guard let target = PairingTarget.parse(code) else {
                    text = code
                    invalid = true
                    return false
                }
                scanning = false
                onPair(target)
                return true
            }
        }
        .sensoryFeedback(.error, trigger: invalid) { _, now in now }
    }

    private func submit() {
        guard let target = PairingTarget.parse(text) else {
            invalid = true
            return
        }
        onPair(target)
    }

    private func scan() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            scanning = true
        case .notDetermined:
            Task {
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                cameraDenied = !granted
                scanning = granted
            }
        default:
            cameraDenied = true
        }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }
}

extension PairingForm where Footer == EmptyView {
    init(refusal: String? = nil, onPair: @escaping (PairingTarget) -> Void) {
        self.init(refusal: refusal, onPair: onPair) { EmptyView() }
    }
}

/// The lead paragraph with its symbol above it, centered, like the top of a system setup screen.
private struct PairingLeadLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(spacing: 12) {
            configuration.icon
                .font(.system(size: 44))
                .accessibilityHidden(true)
            configuration.title
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }
}

/// The camera, full screen, with the hint floating over it and Cancel in the toolbar.
private struct ScannerScreen: View {
    let onScan: (String) -> Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PairingScanner(onScan: onScan)
                .ignoresSafeArea()
                .overlay(alignment: .bottom) {
                    Text(.mobilePairingScanHint)
                        .font(.callout)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 12)
                        .glassEffect(in: .capsule)
                        .padding()
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(role: .cancel) {
                            dismiss()
                        } label: {
                            Text(.mobilePairingCancel)
                        }
                    }
                }
        }
    }
}
