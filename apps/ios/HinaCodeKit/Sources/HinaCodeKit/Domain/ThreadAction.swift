/// An action a thread row offers on long press. Copying the id happens on the phone; the rest ask the desktop.
public enum ThreadAction: Hashable, Sendable {
    case pin
    case unpin
    case copyId
    case archive
    case unarchive

    /// An archived thread can only come back, an active one can be pinned.
    public static func offered(by thread: AgentThread) -> [ThreadAction] {
        if thread.status == .archived { return [.copyId, .unarchive] }
        return [thread.pinnedAt == nil ? .pin : .unpin, .copyId, .archive]
    }
}
