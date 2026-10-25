import Foundation
import Observation

/// Unsent composer text per thread, so it survives tab and thread switches and relaunches.
@MainActor
@Observable
public final class DraftsStore {
    /// Where the first turn runs. `local` switches the project root to `ref`, `worktree` makes a new worktree from it.
    public struct Workspace: Codable, Hashable, Sendable {
        public let mode: WorkspaceChoice.Mode
        /// What the user typed: a branch, or a pull request number or URL.
        public let ref: String

        public init(mode: WorkspaceChoice.Mode, ref: String) {
            self.mode = mode
            self.ref = ref
        }
    }

    public struct SendingPrompt: Hashable, Sendable, Identifiable {
        public let id: Int
        public let text: String
    }

    /// By thread id. A thread without a draft is absent.
    public private(set) var texts: [String: String] { didSet { save(texts, Self.textsKey) } }
    /// Picked before the first message. A thread without one runs in the project root as it is.
    public private(set) var workspaces: [String: Workspace] { didSet { save(workspaces, Self.workspacesKey) } }
    /// Prompts sent but not answered yet, shown until the desktop accepts or finally refuses them.
    public private(set) var sending: [String: [SendingPrompt]] = [:]

    private static let textsKey = "hinacode.drafts"
    private static let workspacesKey = "hinacode.draftWorkspaces"

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var lastSendingId = 0

    public init(defaults: UserDefaults) {
        self.defaults = defaults
        texts = Self.stored(Self.textsKey, in: defaults)
        workspaces = Self.stored(Self.workspacesKey, in: defaults)
    }

    public func setText(_ text: String, threadId: String) {
        texts[threadId] = text.isEmpty ? nil : text
    }

    public func setWorkspace(_ workspace: Workspace?, threadId: String) {
        workspaces[threadId] = workspace
    }

    /// Empties the draft for sending and returns what it held, so anything typed while the send is pending is kept.
    public func take(threadId: String) -> String {
        let text = texts[threadId] ?? ""
        setText("", threadId: threadId)
        return text
    }

    /// Puts a draft whose send failed back in front of whatever was typed since.
    public func restore(_ sent: String, threadId: String) {
        let typed = texts[threadId] ?? ""
        setText([sent, typed].filter { !$0.isEmpty }.joined(separator: "\n"), threadId: threadId)
    }

    /// Runs `send` for `text`, listing it as sending until it settles.
    public func trackSending<Value>(threadId: String, text: String, _ send: () async throws -> Value)
        async rethrows -> Value
    {
        lastSendingId += 1
        let prompt = SendingPrompt(id: lastSendingId, text: text)
        sending[threadId, default: []].append(prompt)
        defer {
            sending[threadId]?.removeAll { $0 == prompt }
            if sending[threadId]?.isEmpty == true { sending[threadId] = nil }
        }
        return try await send()
    }

    private func save(_ value: some Encodable, _ key: String) {
        defaults.set(try? JSONEncoder().encode(value), forKey: key)
    }

    private static func stored<Value: Decodable & ExpressibleByDictionaryLiteral>(
        _ key: String, in defaults: UserDefaults
    ) -> Value {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Value.self, from: $0) } ?? [:]
    }
}
