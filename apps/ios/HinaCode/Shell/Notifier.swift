import HinaCodeKit
import SwiftUI
import UserNotifications

/// Turns thread events into notifications and unseen marks (inventory §4). The system banner shows them while the
/// app is open, so there is no in-app banner of our own; the thread on screen never alerts.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private let model: AppModel
    private let router: Router
    private let center = UNUserNotificationCenter.current()
    var appActive = true

    init(model: AppModel, router: Router) {
        self.model = model
        self.router = router
        super.init()
        center.delegate = self
        model.onThreadEvent = { [weak self] threadId, event in self?.receive(threadId: threadId, event: event) }
    }

    /// Asks once, after the first pairing, as the Expo app does. Provisional authorization counts as granted.
    func requestAuthorizationIfUndetermined() async {
        guard await center.notificationSettings().authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    private var viewing: String? { router.openThreadId }

    private func receive(threadId: String, event: AgentEvent) {
        let thread = model.threads.threads[threadId]
        let queued = thread?.queue.count ?? 0
        let onScreen = appActive && viewing == threadId

        if let outcome = ThreadOutcome(event: event), !(outcome == .completed && queued > 0), !onScreen {
            model.unseen.record(outcome, threadId: threadId)
        }

        guard let alert = ThreadAlert(event: event),
            alert.delivery(
                enabled: model.preferences.notifications.isEnabled(alert.kind),
                queued: queued,
                appActive: appActive,
                viewing: viewing == threadId
            ) != nil
        else { return }

        let content = UNMutableNotificationContent()
        let title = thread?.title ?? ""
        content.title = title.isEmpty ? String(localized: .mobileNotifyUntitled) : title
        content.body = String(localized: alert.body.text)
        content.threadIdentifier = threadId
        content.userInfo = ["threadId": threadId]
        content.sound = appActive ? nil : .default
        content.interruptionLevel = alert.kind == .needsInput ? .active : .passive
        center.add(UNNotificationRequest(identifier: threadId, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        guard let threadId = response.notification.request.content.userInfo["threadId"] as? String else { return }
        await MainActor.run { router.open(thread: threadId) }
    }
}

extension PhonePreferences.Notifications {
    func isEnabled(_ kind: ThreadAlert.Kind) -> Bool {
        switch kind {
        case .completed: completed
        case .needsInput: needsInput
        case .failed: failed
        }
    }
}

extension ThreadAlert.Body {
    var text: LocalizedStringResource {
        switch self {
        case .completed: .mobileNotifyCompleted
        case .approval: .mobileNotifyApproval
        case .question: .mobileNotifyQuestion
        case .secret: .mobileNotifySecret
        case .failed(let message): .mobileNotifyFailed(message)
        case .limited: .mobileNotifyLimited
        }
    }
}
