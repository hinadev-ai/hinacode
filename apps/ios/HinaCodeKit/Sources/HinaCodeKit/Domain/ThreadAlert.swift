/// The notice an agent event raises, the same table as the desktop's. Most events raise none.
public struct ThreadAlert: Hashable, Sendable {
    /// The raw values are the keys of the notification preferences, so each kind can be turned off on its own.
    public enum Kind: String, Hashable, Sendable, CaseIterable {
        case completed
        case needsInput
        case failed
    }

    /// What the notice says. The view localizes it.
    public enum Body: Hashable, Sendable {
        case completed
        case approval
        case question
        case secret
        /// `message` is the first line of the failure.
        case failed(message: String)
        case limited
    }

    /// Where an alert shows.
    public enum Delivery: Hashable, Sendable {
        /// A system notification, for an app in the background.
        case notification
        /// The in-app banner, for a thread the developer is not looking at.
        case banner
    }

    public var kind: Kind
    public var body: Body

    public init(kind: Kind, body: Body) {
        self.kind = kind
        self.body = body
    }

    public init?(event: AgentEvent) {
        switch event {
        case .turnCompleted: self.init(kind: .completed, body: .completed)
        case .approvalRequested: self.init(kind: .needsInput, body: .approval)
        case .questionRequested: self.init(kind: .needsInput, body: .question)
        case .secretRequested: self.init(kind: .needsInput, body: .secret)
        case .turnFailed(let failure):
            // By scalar, as JavaScript splits: "\r\n" is one Character, so a Character search never finds its "\n".
            let firstLine = failure.message.unicodeScalars.prefix { $0 != "\n" }
            self.init(kind: .failed, body: .failed(message: String(firstLine)))
        case .turnLimited: self.init(kind: .failed, body: .limited)
        default: return nil
        }
    }

    /// Where this alert shows, or nil when it should not show at all.
    ///
    /// - Parameters:
    ///   - enabled: The developer's notification preference for `kind`.
    ///   - queued: Messages queued on the thread. A finished turn with messages behind it is not the end of its work.
    ///   - appActive: The app is in the foreground.
    ///   - viewing: The developer is on the thread, or on one of its pages such as a file or a pull request.
    public func delivery(enabled: Bool, queued: Int, appActive: Bool, viewing: Bool) -> Delivery? {
        guard enabled, !(kind == .completed && queued > 0) else { return nil }
        if !appActive { return .notification }
        return viewing ? nil : .banner
    }
}
