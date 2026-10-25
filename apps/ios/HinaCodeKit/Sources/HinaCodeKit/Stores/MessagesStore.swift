import Foundation
import Observation

/// Transcript, pending approvals and questions per thread, mirroring the desktop's `stores/messages.ts`. Threads that
/// were never opened ignore pushes: their first `load` reads a snapshot instead.
@MainActor
@Observable
public final class MessagesStore {
    public enum History: Equatable, Sendable {
        case loading
        case error(String)
        case ready(Transcript)
    }

    public struct Transcript: Equatable, Sendable {
        public var messages: [Message]
        public var approvals: [ApprovalRequest]
        public var questions: [QuestionRequest]
    }

    /// By thread id. A thread is absent until something loads it.
    public private(set) var histories: [String: History] = [:]

    private static let streamPublicationInterval: Duration = .milliseconds(100)

    @ObservationIgnored private let caller: any Caller
    @ObservationIgnored private let timers: any Timers
    @ObservationIgnored private var lastToken = 0
    @ObservationIgnored private var loadTokens: [String: Int] = [:]
    /// Pushes that arrive before a load's snapshot, which may or may not contain them.
    @ObservationIgnored private var pushesDuringLoad: [String: [TranscriptPush]] = [:]
    @ObservationIgnored private var reloads: [String: Reload] = [:]
    @ObservationIgnored private var deltaBatches: [String: DeltaBatch] = [:]

    public init(caller: any Caller, timers: any Timers) {
        self.caller = caller
        self.timers = timers
    }

    /// Loads a thread's history once; later changes arrive through `receive`. A failed load can be tried again.
    public func load(threadId: String) async {
        switch histories[threadId] {
        case nil, .error: break
        case .loading, .ready: return
        }
        histories[threadId] = .loading
        pushesDuringLoad[threadId] = []
        let token = nextToken()
        loadTokens[threadId] = token

        func settleIfStillCurrent(_ update: (_ pending: [TranscriptPush]) -> History) {
            guard loadTokens[threadId] == token else { return }
            loadTokens[threadId] = nil
            let pending = pushesDuringLoad.removeValue(forKey: threadId) ?? []
            if case .loading = histories[threadId] { histories[threadId] = update(pending) }
        }
        do {
            let snapshot = try await readTranscript(threadId)
            settleIfStillCurrent { .ready(Self.replaying($0, over: snapshot)) }
        } catch {
            settleIfStillCurrent { _ in .error(error.localizedDescription) }
        }
    }

    /// Reads every loaded history again after a reconnect, since pushes sent while the socket was down are lost. The
    /// last known history stays on screen until its new snapshot replaces it in one step.
    public func reload() {
        for (threadId, history) in histories {
            switch history {
            case .loading:
                continue
            case .error:
                Task.immediate { await self.load(threadId: threadId) }
            case .ready:
                let token = nextToken()
                reloads[threadId] = Reload(token: token)
                Task.immediate { await self.finishReload(threadId, token: token) }
            }
        }
    }

    /// Forgets every history, when the phone disconnects or unpairs.
    public func reset() {
        for batch in deltaBatches.values { batch.timer.cancel() }
        deltaBatches = [:]
        loadTokens = [:]
        pushesDuringLoad = [:]
        reloads = [:]
        histories = [:]
    }

    /// Folds a `thread.event`, `message.created` or `message.updated` push into its thread's history and ignores any
    /// other push. Streamed deltas are applied together every 100 ms.
    public func receive(_ push: PushEvent) {
        guard let push = TranscriptPush(push) else { return }
        let threadId = push.threadId
        reloads[threadId]?.pushes.append(push)
        if case .ready = histories[threadId], let kind = push.deltaKind {
            if let batch = deltaBatches[threadId] {
                if batch.kind == kind {
                    deltaBatches[threadId]?.pushes.append(push)
                    return
                }
            } else {
                // Started once per batch, so later deltas never postpone publication.
                let timer = timers.after(Self.streamPublicationInterval) { [weak self] in
                    self?.publishDeltas(threadId)
                }
                deltaBatches[threadId] = DeltaBatch(kind: kind, pushes: [push], timer: timer)
                return
            }
        }
        let batched = takeDeltaBatch(threadId)
        switch histories[threadId] {
        case .loading:
            pushesDuringLoad[threadId, default: []].append(push)
        case .ready(var transcript):
            for push in batched + [push] { Self.apply(push, to: &transcript) }
            histories[threadId] = .ready(transcript)
        case .error, nil:
            break
        }
    }

    private func readTranscript(_ threadId: String) async throws -> ThreadsTranscriptResponse {
        try await caller.call(RPC.threadsTranscript, ThreadsTranscriptRequest(threadId: threadId, compact: true))
    }

    private func finishReload(_ threadId: String, token: Int) async {
        let snapshot = try? await readTranscript(threadId)
        guard let reload = reloads[threadId], reload.token == token else { return }
        reloads[threadId] = nil
        guard let snapshot else { return }
        takeDeltaBatch(threadId)
        if case .ready = histories[threadId] {
            histories[threadId] = .ready(Self.replaying(reload.pushes, over: snapshot))
        }
    }

    private func publishDeltas(_ threadId: String) {
        let pushes = takeDeltaBatch(threadId)
        guard case .ready(var transcript) = histories[threadId] else { return }
        for push in pushes { Self.apply(push, to: &transcript) }
        histories[threadId] = .ready(transcript)
    }

    @discardableResult
    private func takeDeltaBatch(_ threadId: String) -> [TranscriptPush] {
        guard let batch = deltaBatches.removeValue(forKey: threadId) else { return [] }
        batch.timer.cancel()
        return batch.pushes
    }

    private func nextToken() -> Int {
        lastToken += 1
        return lastToken
    }

    private static func replaying(_ pushes: [TranscriptPush], over snapshot: ThreadsTranscriptResponse) -> Transcript {
        var transcript = Transcript(
            messages: snapshot.messages, approvals: snapshot.approvals, questions: snapshot.questions)
        for push in pushes where push.seq > snapshot.seq { apply(push, to: &transcript) }
        return transcript
    }

    private static func apply(_ push: TranscriptPush, to transcript: inout Transcript) {
        switch push.event {
        case .messageCreated(let created):
            transcript.messages.append(created.message)
        case .messageUpdated(let updated):
            if let index = transcript.messages.firstIndex(where: { $0.id == updated.message.id }) {
                transcript.messages[index] = updated.message
            }
        case .threadEvent(let pushed):
            transcript.approvals = foldApprovals(transcript.approvals, pushed.event)
            transcript.questions = foldQuestions(transcript.questions, pushed.event)
            transcript.messages = foldTranscript(
                transcript.messages, pushed.event,
                now: Date.now.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
        default:
            break
        }
    }

    private static func foldApprovals(_ approvals: [ApprovalRequest], _ event: AgentEvent) -> [ApprovalRequest] {
        switch event {
        case .approvalRequested(let requested): approvals + [requested.request]
        case .approvalResolved(let resolved): approvals.filter { $0.id != resolved.requestId }
        case .turnCompleted, .turnFailed: []
        default: approvals
        }
    }

    private static func foldQuestions(_ questions: [QuestionRequest], _ event: AgentEvent) -> [QuestionRequest] {
        switch event {
        case .questionRequested(let requested): questions + [requested.request]
        case .questionResolved(let resolved): questions.filter { $0.id != resolved.requestId }
        case .turnCompleted, .turnFailed, .turnLimited: []
        default: questions
        }
    }
}

extension MessagesStore {
    /// A push that changes a transcript. `seq` increases across every thread on a server.
    private struct TranscriptPush {
        let seq: Double
        let threadId: String
        let event: PushEvent

        init?(_ push: PushEvent) {
            switch push {
            case .threadEvent(let pushed):
                seq = pushed.seq
                threadId = pushed.threadId
            case .messageCreated(let created):
                seq = created.seq
                threadId = created.message.threadId
            case .messageUpdated(let updated):
                seq = updated.seq
                threadId = updated.message.threadId
            default:
                return nil
            }
            event = push
        }

        var deltaKind: DeltaKind? {
            guard case .threadEvent(let pushed) = event else { return nil }
            switch pushed.event {
            case .textDelta: return .text
            case .reasoningDelta: return .reasoning
            default: return nil
            }
        }
    }

    private enum DeltaKind {
        case text, reasoning
    }

    private struct DeltaBatch {
        let kind: DeltaKind
        var pushes: [TranscriptPush]
        let timer: TimerHandle
    }

    /// Pushes recorded while a reload's snapshot is read, to replay the ones it predates.
    private struct Reload {
        let token: Int
        var pushes: [TranscriptPush] = []
    }
}
