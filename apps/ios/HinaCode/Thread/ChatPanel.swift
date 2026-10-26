import HinaCodeKit
import SwiftUI

/// The transcript, with the approval and question cards and the composer floating below it. Always mounted;
/// the composer bar only shows while Chat is the selected tab.
struct ChatPanel: View {
    let threadId: String
    let isSelected: Bool

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scrollPosition = ScrollPosition(edge: .bottom)
    @State private var isAtBottom = true

    private var history: MessagesStore.History? { model.messages.histories[threadId] }
    private var thread: AgentThread? { model.threads.threads[threadId] }
    private var root: String? { thread.flatMap { model.threads.root(of: $0) } }

    var body: some View {
        content
            .safeAreaBar(edge: .bottom) {
                if isSelected {
                    VStack(spacing: 8) {
                        pendingCards
                        Composer(threadId: threadId)
                    }
                    .animation(
                        reduceMotion ? .easeInOut(duration: 0.2) : .spring(duration: 0.35, bounce: 0.15),
                        value: pendingIds
                    )
                    .frame(maxWidth: 760)
                    .frame(maxWidth: .infinity)
                }
            }
            .task(id: threadId) { await model.messages.load(threadId: threadId) }
    }

    @ViewBuilder private var content: some View {
        switch history {
        case .error(let message):
            ContentUnavailableView {
                Label {
                    Text(.mobileThreadActionFailed)
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                }
            } description: {
                Text(verbatim: message)
            } actions: {
                Button {
                    Task { await model.messages.load(threadId: threadId) }
                } label: {
                    Text(.mobileChatRetry)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
        case .ready(let transcript):
            if transcript.messages.isEmpty {
                emptyTranscript
            } else {
                transcriptView(transcript)
            }
        case .loading, nil:
            ProgressView { Text(.mobileChatLoading) }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel(Text(.mobileChatLoading))
        }
    }

    /// Who will answer, so the first prompt goes to a face rather than a blank page.
    @ViewBuilder private var emptyTranscript: some View {
        if let thread {
            ContentUnavailableView {
                Label {
                    Text(thread.provider.name)
                } icon: {
                    ProviderMark(provider: thread.provider, size: 44)
                }
            } description: {
                Text(.mobileChatEmpty)
            }
        }
    }

    private func transcriptView(_ transcript: MessagesStore.Transcript) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                ForEach(transcript.messages) { message in
                    MessageRow(message: message, root: root)
                        .equatable()
                        .id(message.id)
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(16)
        }
        .defaultScrollAnchor(.bottom)
        .scrollPosition($scrollPosition)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.visibleRect.maxY - geometry.contentInsets.bottom >= geometry.contentSize.height - 80
        } action: { _, atBottom in
            isAtBottom = atBottom
        }
        .onChange(of: transcript.messages) {
            if isAtBottom { scrollToBottom(animated: false) }
        }
        .overlay(alignment: .bottomTrailing) {
            if !isAtBottom {
                Button {
                    scrollToBottom(animated: true)
                } label: {
                    Image(systemName: "arrow.down")
                        .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.glass)
                .padding()
                .accessibilityLabel(Text(.mobileChatJumpLatest))
            }
        }
        .accessibilityLabel(Text(.mobileChatTranscript))
    }

    private var pendingIds: [String] {
        guard case .ready(let transcript) = history else { return [] }
        return transcript.approvals.map(\.id) + transcript.questions.map(\.id)
    }

    @ViewBuilder private var pendingCards: some View {
        if case .ready(let transcript) = history, !transcript.approvals.isEmpty || !transcript.questions.isEmpty {
            GlassEffectContainer {
                VStack(spacing: 8) {
                    ForEach(transcript.approvals) { request in
                        ApprovalCard(request: request)
                            .transition(cardTransition)
                    }
                    ForEach(transcript.questions) { request in
                        QuestionCard(request: request)
                            .transition(cardTransition)
                    }
                }
            }
            .transition(cardTransition)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
            .padding(.horizontal)
        }
    }

    /// A card rises out of the composer it sits on and sinks back into it once answered. Reduce Motion fades it.
    private var cardTransition: AnyTransition {
        reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity)
    }

    private func scrollToBottom(animated: Bool) {
        if animated && !reduceMotion {
            withAnimation(.easeInOut(duration: 0.25)) { scrollPosition.scrollTo(edge: .bottom) }
        } else {
            scrollPosition.scrollTo(edge: .bottom)
        }
    }
}
