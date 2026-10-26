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
    /// The text that failed to parse; the error shows until the text changes.
    @State private var rejected: String?
    @State private var scanning = false
    @State private var cameraDenied = false

    var body: some View {
        Form {
            Group {
                Section {
                    PairingHeader()
                }
                .listRowBackground(Color.clear)

                if let refusal {
                    Section {
                        Label(refusal, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Palette.destructive)
                    }
                }

                Section {
                    actions
                } footer: {
                    if cameraDenied {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(.mobilePairingCameraDenied)
                            Button(.mobilePairingOpenSettings, action: openSettings)
                        }
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())

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
                    .accessibilityIdentifier("pairing-url")

                    Button(.mobilePairingConnect, action: submit)
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("pairing-connect")
                } header: {
                    Text(.mobilePairingUrl)
                } footer: {
                    if rejected == text {
                        Text(.mobilePairingInvalid)
                            .foregroundStyle(Palette.destructive)
                            .accessibilityAddTraits(.isStaticText)
                    } else {
                        Text(.mobilePairingUrlFootnote)
                    }
                }

                footer
            }
            .listRowBackground(Palette.background)
        }
        .paletteList()
        // One readable column on iPad, the way setup screens stay narrow on a wide display.
        .frame(maxWidth: 600)
        .frame(maxWidth: .infinity)
        .background(Palette.page)
        .fullScreenCover(isPresented: $scanning) {
            ScannerScreen { code in
                guard let target = PairingTarget.parse(code) else {
                    text = code
                    rejected = code
                    return false
                }
                scanning = false
                onPair(target)
                return true
            }
        }
        .sensoryFeedback(.error, trigger: rejected) { _, now in now != nil }
    }

    /// Scan when the camera can read QR codes, with Paste under it. The system Paste button reads the clipboard
    /// without asking, and dims itself while there is nothing to paste.
    private var actions: some View {
        VStack(spacing: 12) {
            if PairingScanner.isSupported {
                Button(action: scan) {
                    Text(.mobilePairingScan)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .accessibilityIdentifier("pairing-scan")
            }
            PasteButton(payloadType: String.self) { strings in
                text = strings.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                submit()
            }
            .buttonBorderShape(.capsule)
            .labelStyle(.titleAndIcon)
        }
        .controlSize(.large)
        .frame(maxWidth: .infinity)
    }

    private func submit() {
        guard let target = PairingTarget.parse(text) else {
            rejected = text
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

/// The top of a system setup screen: the symbol, the title and one lead line, centered.
private struct PairingHeader: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "macbook.and.iphone")
                .font(.system(size: 56))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text(.mobileConnectTitle)
                .font(.title.bold())
                .accessibilityAddTraits(.isHeader)
            Text(.mobilePairingLead)
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
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
