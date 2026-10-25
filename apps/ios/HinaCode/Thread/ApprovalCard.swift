import HinaCodeKit
import SwiftUI

/// A pending approval, floating above the composer on glass. The card leaves when the desktop resolves it.
struct ApprovalCard: View {
    let request: ApprovalRequest

    @Environment(AppModel.self) private var model
    @State private var busy: ApprovalDecision?
    @State private var error: String?
    @State private var answered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: request.title)
                .font(.subheadline.weight(.semibold))
                .textSelection(.enabled)
            if !request.detail.isEmpty {
                ScrollView {
                    Text(verbatim: request.detail)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
                .padding(8)
                .background(.fill.quaternary, in: .rect(cornerRadius: 6))
            }
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button(role: .destructive) {
                    respond(.deny)
                } label: {
                    Text(.mobileChatDeny)
                }
                .buttonStyle(.glass)
                .disabled(busy != nil)
                .accessibilityIdentifier("approval-deny")
                if request.sessionScope != nil {
                    Button {
                        respond(.allowForSession)
                    } label: {
                        Text(.mobileChatAllowSession)
                    }
                    .buttonStyle(.glass)
                    .disabled(busy != nil)
                }
                Button {
                    respond(.allow)
                } label: {
                    if busy == .allow {
                        ProgressView()
                    } else {
                        Text(.mobileChatAllow)
                    }
                }
                .buttonStyle(.glassProminent)
                .disabled(busy != nil && busy != .allow)
                .accessibilityIdentifier("approval-allow")
            }
            if let error {
                Text(verbatim: error)
                    .font(.footnote)
                    .foregroundStyle(Tone.danger.color)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .padding(12)
        .glassEffect(.regular.tint(Tone.attention.color.opacity(0.15)), in: .rect(cornerRadius: 18))
        .sensoryFeedback(.success, trigger: answered)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(.mobileChatApproval(request.title)))
    }

    private func respond(_ decision: ApprovalDecision) {
        busy = decision
        error = nil
        Task {
            do {
                _ = try await model.hub.call(
                    RPC.approvalsRespond, ApprovalsRespondRequest(requestId: request.id, decision: decision))
                answered = true
            } catch {
                self.error = error.localizedDescription
            }
            busy = nil
        }
    }
}
