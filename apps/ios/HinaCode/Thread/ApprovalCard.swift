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
            Label {
                Text(verbatim: request.title)
                    .font(.subheadline.weight(.semibold))
                    .textSelection(.enabled)
            } icon: {
                Image(systemName: "hand.raised.fill")
                    .foregroundStyle(Tone.attention.color)
            }
            if !request.detail.isEmpty {
                ScrollView { detail }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(maxHeight: 160)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10)
                    .background(.background.opacity(0.6), in: .rect(cornerRadius: 10))
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons }
                VStack(spacing: 8) { buttons }
            }
            .controlSize(.large)
            .buttonBorderShape(.capsule)
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

    private var detail: some View {
        Text(verbatim: request.detail)
            .font(.system(.footnote, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Plain bordered buttons, since glass cannot sit on the card's glass.
    @ViewBuilder private var buttons: some View {
        Button(role: .destructive) {
            respond(.deny)
        } label: {
            Text(.mobileChatDeny)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(busy != nil)
        .accessibilityIdentifier("approval-deny")
        if request.sessionScope != nil {
            Button {
                respond(.allowForSession)
            } label: {
                Text(.mobileChatAllowSession)
                    .lineLimit(1)
                    .fixedSize()
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(busy != nil)
        }
        Button {
            respond(.allow)
        } label: {
            Group {
                if busy == .allow {
                    ProgressView()
                } else {
                    Text(.mobileChatAllow)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(busy != nil && busy != .allow)
        .accessibilityIdentifier("approval-allow")
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
