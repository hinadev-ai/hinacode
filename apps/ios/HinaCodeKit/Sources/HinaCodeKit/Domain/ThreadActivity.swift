import Foundation

#if os(iOS)
    import ActivityKit
#endif

/// The thread a Live Activity follows. It stays the same for the activity's life.
public struct ThreadActivityAttributes: Codable, Hashable, Sendable {
    public var threadId: String
    public var title: String
    public var provider: ProviderId
    public var project: String

    public init(threadId: String, title: String, provider: ProviderId, project: String) {
        self.threadId = threadId
        self.title = title
        self.provider = provider
        self.project = project
    }
}

/// Where a thread's turn is, as its Live Activity shows it. Plain JSON, the `content-state` an ActivityKit push
/// carries, so a push path can send it as is.
public struct ThreadActivityState: Codable, Hashable, Sendable {
    public enum Phase: String, Codable, Hashable, Sendable {
        case working
        case needsYou
        case finished
        case failed
        case limited

        /// The turn is over and the clock stops.
        public var isEnded: Bool { self == .finished || self == .failed || self == .limited }
    }

    public var phase: Phase
    /// When the turn started, for the running clock.
    public var startedAt: Date
    /// When the turn ended. Nil while it runs.
    public var endedAt: Date?
    /// The step the agent is on, what it asks, or the first line of its failure.
    public var detail: String?

    public init(phase: Phase, startedAt: Date, endedAt: Date? = nil, detail: String? = nil) {
        self.phase = phase
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.detail = detail
    }

    /// A turn just sent from this phone.
    public static func started(at date: Date) -> Self {
        Self(phase: .working, startedAt: date)
    }
}

#if os(iOS)
    extension ThreadActivityAttributes: ActivityAttributes {
        public typealias ContentState = ThreadActivityState
    }
#endif

/// The threads widget's whole input: the threads worth a glance, written by the app into the shared App Group.
/// The widget never reaches a desktop, so `takenAt` says how old it is.
public struct WidgetSnapshot: Codable, Hashable, Sendable {
    public enum State: String, Codable, Hashable, Sendable {
        case needsYou
        case failed
        case finished
        case working
    }

    public struct Thread: Codable, Hashable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var provider: ProviderId
        public var project: String
        public var state: State
        public var updatedAt: Date

        public init(id: String, title: String, provider: ProviderId, project: String, state: State, updatedAt: Date) {
            self.id = id
            self.title = title
            self.provider = provider
            self.project = project
            self.state = state
            self.updatedAt = updatedAt
        }
    }

    public static let appGroup = "group.app.hinacode.ios"
    public static let defaultsKey = "widget-snapshot"
    /// The most rows any widget size lists.
    public static let limit = 6

    public var takenAt: Date
    /// Most urgent first, at most `limit`.
    public var threads: [Thread]
    public var needsYou: Int
    public var working: Int

    public init(takenAt: Date, threads: [Thread], needsYou: Int, working: Int) {
        self.takenAt = takenAt
        self.threads = threads
        self.needsYou = needsYou
        self.working = working
    }
}

/// `hinacode://thread?id=<id>`, how a Live Activity or a widget opens a thread.
public enum ThreadLink {
    public static func url(threadId: String) -> URL {
        var components = URLComponents()
        components.scheme = "hinacode"
        components.host = "thread"
        components.queryItems = [URLQueryItem(name: "id", value: threadId)]
        return components.url!
    }

    public static func threadId(in url: URL) -> String? {
        guard url.scheme == "hinacode", url.host == "thread",
            let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: {
                $0.name == "id"
            })?.value, !id.isEmpty
        else { return nil }
        return id
    }
}

extension ThreadActivityState {
    /// The state after `event`. A turn that finishes with `queued` messages behind it is not the end of the work.
    public func applying(_ event: AgentEvent, at date: Date, queued: Int) -> Self {
        var next = self
        switch event {
        case .toolCallStarted(let call) where call.parentCallId == nil:
            next.phase = .working
            next.detail = call.input.toolSummary.map { "\(call.name) \($0)" } ?? call.name
        case .approvalRequested(let requested):
            next.phase = .needsYou
            next.detail = requested.request.title
        case .questionRequested(let requested):
            next.phase = .needsYou
            next.detail = requested.request.questions.first?.question
        case .secretRequested(let requested):
            next.phase = .needsYou
            next.detail = requested.request.name
        case .approvalResolved, .questionResolved, .secretResolved:
            next.phase = .working
            next.detail = nil
        case .turnCompleted:
            guard queued == 0 else { return self }
            next.phase = .finished
            next.endedAt = date
            next.detail = nil
        case .turnFailed(let failure):
            next.phase = .failed
            next.endedAt = date
            next.detail = String(failure.message.unicodeScalars.prefix { $0 != "\n" })
        case .turnLimited:
            next.phase = .limited
            next.endedAt = date
            next.detail = nil
        default:
            return self
        }
        return next
    }

    /// The state a thread's status implies, for a reload that may have missed the events in between.
    public func reconciled(with status: ThreadStatus, at date: Date) -> Self {
        var next = self
        switch status {
        case .running where phase != .working:
            next = Self(phase: .working, startedAt: phase.isEnded ? date : startedAt)
        case .awaitingApproval where phase != .needsYou:
            next.phase = .needsYou
            next.endedAt = nil
        case .limited where phase != .limited:
            next.phase = .limited
            next.endedAt = endedAt ?? date
            next.detail = nil
        case .idle, .archived:
            guard !phase.isEnded else { return self }
            next.phase = .finished
            next.endedAt = date
            next.detail = nil
        default:
            return self
        }
        return next
    }
}

extension WidgetSnapshot {
    /// Picks the threads worth a glance. Archived, idle and seen threads stay out; the counts cover every thread.
    public init(threads: [AgentThread], projects: [Project], unseen: [String: ThreadOutcome], at date: Date) {
        let names = Dictionary(projects.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        let listed = threads.compactMap { thread -> Thread? in
            guard let state = Self.state(ThreadRowState(status: thread.status, unseen: unseen[thread.id])) else {
                return nil
            }
            return Thread(
                id: thread.id, title: thread.title, provider: thread.provider, project: names[thread.projectId] ?? "",
                state: state, updatedAt: (try? Date(thread.updatedAt, strategy: .iso8601)) ?? .distantPast)
        }
        let order: [State] = [.needsYou, .failed, .finished, .working]
        let sorted = listed.sorted { left, right in
            let (leftRank, rightRank) = (order.firstIndex(of: left.state)!, order.firstIndex(of: right.state)!)
            return leftRank != rightRank ? leftRank < rightRank : left.updatedAt > right.updatedAt
        }
        self.init(
            takenAt: date,
            threads: Array(sorted.prefix(Self.limit)),
            needsYou: listed.count { $0.state == .needsYou },
            working: listed.count { $0.state == .working })
    }

    private static func state(_ row: ThreadRowState) -> State? {
        switch row {
        case .awaitingApproval, .limited: .needsYou
        case .unseenFailed: .failed
        case .unseenCompleted: .finished
        case .running: .working
        case .idle, .archived, .unknown: nil
        }
    }
}
