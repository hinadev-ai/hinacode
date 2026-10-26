import ActivityKit
import Foundation
import HinaCodeKit

/// Follows the turns sent from this phone on the Lock Screen and in the Dynamic Island, one activity per thread.
/// Only a live socket can update an activity, so each update marks it stale a few minutes out, and a heartbeat moves
/// that forward while the thread's server answers. A suspended app's activity says it may be out of date.
@MainActor
final class LiveActivities {
    private let threads: ThreadsStore
    private let hub: ServerHub
    private var subscription: PushSubscription?
    private var heartbeat: Task<Void, Never>?

    static let staleAfter: TimeInterval = 180
    private static let heartbeatEvery: Duration = .seconds(60)

    init(threads: ThreadsStore, hub: ServerHub, pushes: PushListeners) {
        self.threads = threads
        self.hub = hub
        subscription = pushes.listen { [weak self] push in self?.receive(push) }
    }

    /// Starts an activity for a turn just sent or steered. A steer into a running turn keeps its activity; a new turn
    /// replaces the last one's at once.
    func follow(threadId: String) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled, let thread = threads.threads[threadId] else { return }
        if let current = activity(for: threadId), !current.content.state.phase.isEnded { return }
        for old in activities(for: threadId) {
            let id = old.id
            Task { await Self.send(nil, to: id, ending: .immediate) }
        }
        let project = threads.projects.first { $0.id == thread.projectId }?.name ?? ""
        let attributes = ThreadActivityAttributes(
            threadId: threadId,
            title: thread.title.isEmpty ? String(localized: .mobileNotifyUntitled) : thread.title,
            provider: thread.provider, project: project)
        _ = try? Activity.request(attributes: attributes, content: Self.content(.started(at: .now)))
        startHeartbeat()
    }

    /// Every activity takes its thread's status, since the events sent while the app was away are lost.
    func reconcileAll() {
        for activity in Activity<ThreadActivityAttributes>.activities {
            guard let thread = threads.threads[activity.attributes.threadId] else { continue }
            move(activity, to: activity.content.state.reconciled(with: thread.status, at: .now))
        }
        startHeartbeat()
    }

    private func receive(_ push: PushEvent) {
        switch push {
        case .threadEvent(let event):
            guard let activity = activity(for: event.threadId) else { return }
            let queued = threads.threads[event.threadId]?.queue.count ?? 0
            move(activity, to: activity.content.state.applying(event.event, at: .now, queued: queued))
        case .threadUpdated(let update):
            guard let activity = activity(for: update.thread.id) else { return }
            move(activity, to: activity.content.state.reconciled(with: update.thread.status, at: .now))
        default:
            break
        }
    }

    private func move(_ activity: Activity<ThreadActivityAttributes>, to state: ThreadActivityState) {
        guard state != activity.content.state else { return }
        let (id, content) = (activity.id, Self.content(state))
        Task { await Self.send(content, to: id, ending: state.phase.isEnded ? .default : nil) }
    }

    private func startHeartbeat() {
        guard heartbeat == nil else { return }
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.heartbeatEvery)
                guard let self, self.refreshStaleDates() else { break }
            }
            self?.heartbeat = nil
        }
    }

    /// Moves the stale date of every running activity whose server answers. False once none is running.
    private func refreshStaleDates() -> Bool {
        let running = Activity<ThreadActivityAttributes>.activities.filter { !$0.content.state.phase.isEnded }
        for activity in running where isConnected(threadId: activity.attributes.threadId) {
            let (id, content) = (activity.id, Self.content(activity.content.state))
            Task { await Self.send(content, to: id, ending: nil) }
        }
        return !running.isEmpty
    }

    private func isConnected(threadId: String) -> Bool {
        guard let projectId = threads.threads[threadId]?.projectId,
            let serverId = threads.projects.first(where: { $0.id == projectId })?.environmentId
        else { return false }
        return hub.servers.first { $0.id == serverId }?.status == .connected
    }

    private func activities(for threadId: String) -> [Activity<ThreadActivityAttributes>] {
        Activity<ThreadActivityAttributes>.activities.filter { $0.attributes.threadId == threadId }
    }

    private func activity(for threadId: String) -> Activity<ThreadActivityAttributes>? {
        activities(for: threadId).first { $0.activityState == .active }
    }

    /// Updates the activity with `id`, or ends it when `ending` is set. By id, since an `Activity` cannot cross into
    /// the task that awaits it.
    nonisolated private static func send(
        _ content: ActivityContent<ThreadActivityState>?, to id: String, ending: ActivityUIDismissalPolicy?
    ) async {
        guard let activity = Activity<ThreadActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        if let ending {
            await activity.end(content, dismissalPolicy: ending)
        } else if let content {
            await activity.update(content)
        }
    }

    private static func content(_ state: ThreadActivityState) -> ActivityContent<ThreadActivityState> {
        ActivityContent(state: state, staleDate: state.phase.isEnded ? nil : .now.addingTimeInterval(staleAfter))
    }
}
