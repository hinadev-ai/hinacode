import Foundation
import HinaCodeKit
import Observation

/// Everything the app knows: the server hub and the stores it feeds, wired the way the Expo app's
/// `ConnectionProvider` wires them. Each handshake reloads the snapshots, since pushes sent while offline are lost.
@MainActor
@Observable
final class AppModel {
    let hub: ServerHub
    let relayAccount: RelayAccountStore
    let threads: ThreadsStore
    let messages: MessagesStore
    let pullRequests: PullRequestsStore
    let drafts: DraftsStore
    let unseen: UnseenStore
    let linear: LinearStore
    let models: ModelsStore
    let preferences: PreferencesStore
    let pushes = PushListeners()
    /// Thread events that may alert, for the notifier.
    @ObservationIgnored var onThreadEvent: ((String, AgentEvent) -> Void)?

    @ObservationIgnored private var networkMonitor: NetworkMonitor?
    @ObservationIgnored private var watchers: [Task<Void, Never>] = []

    /// `caller` replaces the hub as the stores' caller in previews, which answer from sample data.
    init(
        hub: ServerHub, caller: (any Caller)? = nil, defaults: UserDefaults = .standard,
        timers: any Timers = SystemTimers.shared
    ) {
        let caller = caller ?? hub
        self.hub = hub
        relayAccount = RelayAccountStore(hub: hub)
        threads = ThreadsStore(caller: caller)
        messages = MessagesStore(caller: caller, timers: timers)
        pullRequests = PullRequestsStore(caller: caller, timers: timers)
        drafts = DraftsStore(defaults: defaults)
        unseen = UnseenStore()
        linear = LinearStore(caller: caller, timers: timers)
        models = ModelsStore(caller: caller)
        preferences = PreferencesStore(defaults: defaults)
        hub.onEvent = { [weak self] push in self?.route(push) }
    }

    @ObservationIgnored private var started = false

    /// Restores the paired servers, starts watching the network, and reloads after every handshake. A second window
    /// asks again and is ignored.
    func start() {
        guard !started else { return }
        started = true
        hub.restore()
        networkMonitor = NetworkMonitor { [weak hub] in hub?.networkChanged() }
        watchers = [
            Task { [weak self] in
                guard let self else { return }
                for await generation in Observations({ self.hub.generation }) where generation > 0 {
                    await self.reload()
                }
            },
            Task { [weak self] in
                guard let self else { return }
                for await _ in Observations({ self.hub.paired }) { self.messages.reset() }
            },
        ]
        Task { await relayAccount.restore() }
    }

    func setActive(_ active: Bool) {
        hub.setForeground(active)
        if active { Task { await relayAccount.sync() } }
    }

    /// A `hinacode://connect` link pairs, as a scanned code does.
    func open(_ url: URL) {
        if let target = PairingTarget.parse(url.absoluteString) { _ = hub.pair(target) }
    }

    /// Unpairs a server. Its projects and threads leave the lists.
    func forget(server id: String) {
        hub.forget(id: id)
        guard !hub.servers.isEmpty else { return }
        Task { await reload() }
    }

    /// The server a thread runs on, through its project.
    func server(of thread: AgentThread?) -> ServerHub.Server? {
        guard let thread else { return nil }
        return server(ofProject: thread.projectId)
    }

    func server(ofProject projectId: String) -> ServerHub.Server? {
        let serverId = threads.projects.first { $0.id == projectId }?.environmentId
        return hub.servers.first { $0.id == serverId }
    }

    private func reload() async {
        messages.reload()
        async let threadsLoad: Void = threads.load()
        async let pullRequestsLoad: Void = pullRequests.load()
        _ = await (threadsLoad, pullRequestsLoad)
    }

    private func route(_ push: PushEvent) {
        switch push {
        case .threadEvent(let event):
            messages.receive(push)
            onThreadEvent?(event.threadId, event.event)
        case .messageCreated, .messageUpdated:
            messages.receive(push)
        case .threadUpdated(let update):
            threads.upsert(update.thread)
        case .threadRemoved(let removal):
            threads.remove(id: removal.id)
        case .worktreeUpdated(let update):
            threads.upsertWorktree(update.worktree)
        case .threadPullRequests(let update):
            pullRequests.replace(threadId: update.threadId, links: update.links)
        case .pullRequestGuide:
            pullRequests.receive(push)
        case .terminalData, .terminalExited, .unknown:
            break
        }
        pushes.send(push)
    }
}
