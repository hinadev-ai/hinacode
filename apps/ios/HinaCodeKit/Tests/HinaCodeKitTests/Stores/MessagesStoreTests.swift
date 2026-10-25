import HinaCodeKit
import Testing

private func message(_ id: String) -> Message {
    Message(id: id, threadId: "t1", role: .user, parts: [], createdAt: "2026-10-16T00:00:00.000Z")
}

private func snapshot(_ seq: Double, _ ids: [String]) -> ThreadsTranscriptResponse {
    ThreadsTranscriptResponse(messages: ids.map(message), approvals: [], questions: [], secretRequests: [], seq: seq)
}

private func created(_ seq: Double, _ id: String) -> PushEvent {
    .messageCreated(.init(seq: seq, message: message(id)))
}

@MainActor
@Suite("MessagesStore")
struct MessagesStoreTests {
    let caller = FakeCaller()
    let store: MessagesStore

    init() {
        store = MessagesStore(caller: caller, timers: ManualTimers())
    }

    private var history: MessagesStore.History? { store.histories["t1"] }

    private var ids: [String]? {
        guard case .ready(let transcript) = history else { return nil }
        return transcript.messages.map(\.id)
    }

    @discardableResult
    private func load(_ threadId: String = "t1") -> Task<Void, Never> {
        let store = store
        return Task.immediate { await store.load(threadId: threadId) }
    }

    private func loadReady(_ seq: Double, _ messageIds: [String]) async {
        let loading = load()
        caller.calls.removeFirst().resolve(snapshot(seq, messageIds))
        await loading.value
    }

    @Test("applies pushes that arrive before the snapshot only when they are newer")
    func appliesNewerPushes() async {
        let loading = load()
        store.receive(created(4, "old"))
        store.receive(created(6, "new"))
        caller.calls.removeFirst().resolve(snapshot(5, ["old"]))
        await loading.value
        #expect(ids == ["old", "new"])
    }

    @Test("does not let a snapshot from before a reset settle a newer load")
    func snapshotBeforeReset() async {
        load()
        let previousDesktop = caller.calls.removeFirst()
        store.reset()
        load()
        let current = caller.calls.removeFirst()

        previousDesktop.resolve(snapshot(100, ["stale"]))
        await caller.flush()
        #expect(history == .loading)

        current.resolve(snapshot(1, ["fresh"]))
        await caller.flush()
        #expect(ids == ["fresh"])
    }

    @Test("does not let a failure from before a reset settle a newer load")
    func failureBeforeReset() async {
        load()
        let previousDesktop = caller.calls.removeFirst()
        store.reset()
        load()

        previousDesktop.reject(RpcError("Offline", "closed"))
        await caller.flush()
        #expect(history == .loading)
    }

    @Test("keeps the last known history on screen until the new snapshot swaps in")
    func reloadKeepsHistory() async {
        await loadReady(1, ["a"])
        let before = history
        store.reload()
        #expect(caller.calls.map(\.method) == ["threads.transcript"])
        #expect(history == before)

        caller.calls.removeFirst().resolve(snapshot(3, ["a", "b", "c"]))
        await caller.flush()
        #expect(ids == ["a", "b", "c"])
    }

    @Test("shows pushes during the reload and replays only those newer than the snapshot")
    func reloadReplaysNewerPushes() async {
        await loadReady(1, ["a"])
        store.reload()
        store.receive(created(2, "b"))
        store.receive(created(3, "c"))
        #expect(ids == ["a", "b", "c"])

        caller.calls.removeFirst().resolve(snapshot(2, ["a", "b"]))
        await caller.flush()
        #expect(ids == ["a", "b", "c"])
    }

    @Test("keeps the history when the reload fails")
    func reloadFailure() async {
        await loadReady(1, ["a"])
        store.reload()
        caller.calls.removeFirst().reject(RpcError("Timeout", "Timeout"))
        await caller.flush()
        #expect(ids == ["a"])
    }

    @Test("ignores an older reload answered after a newer one started")
    func olderReload() async {
        await loadReady(1, ["a"])
        store.reload()
        let older = caller.calls.removeFirst()
        store.reload()
        let newer = caller.calls.removeFirst()

        newer.resolve(snapshot(5, ["a", "b"]))
        await caller.flush()
        older.resolve(snapshot(2, ["a"]))
        await caller.flush()
        #expect(ids == ["a", "b"])
    }

    @Test("does not let a reload from before a reset settle the next desktop's history")
    func reloadBeforeReset() async {
        await loadReady(1, ["a"])
        store.reload()
        let previousDesktop = caller.calls.removeFirst()
        store.reset()
        await loadReady(1, ["x"])

        previousDesktop.resolve(snapshot(9, ["stale"]))
        await caller.flush()
        #expect(ids == ["x"])
    }

    @Test("loads again a history whose first load failed, and leaves one still loading to its own call")
    func reloadRetriesFailedLoads() async {
        let failing = load()
        caller.calls.removeFirst().reject(RpcError("Offline", "offline"))
        await failing.value
        load("t2")
        caller.calls.removeAll()

        store.reload()
        #expect(
            caller.calls.map { $0.payload as? ThreadsTranscriptRequest } == [
                ThreadsTranscriptRequest(threadId: "t1", compact: true)
            ])
    }
}
