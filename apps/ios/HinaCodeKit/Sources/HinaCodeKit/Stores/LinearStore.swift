import Observation

/// Linear issues assigned to the developer, from every server, for the overview.
@MainActor
@Observable
public final class LinearStore {
    /// Nil until the first read. A `SchemaError` failure means the desktop predates Linear tickets.
    public private(set) var issues: RemoteValue<[LinearIssue]>?
    /// Whether the server has a Linear key, so an empty list can say why. Nil when unknown.
    public private(set) var configured: Bool?

    /// Each read is a Linear API call on the server, so the list is read at most this often unless forced.
    private static let issuesMaxAge: Duration = .seconds(60)

    @ObservationIgnored private let caller: any Caller
    @ObservationIgnored private let timers: any Timers
    @ObservationIgnored private var inflight: Task<Void, Never>?

    public init(caller: any Caller, timers: any Timers) {
        self.caller = caller
        self.timers = timers
    }

    /// Reads the issues, one read at a time, unless the list is under a minute old and `force` is false.
    public func load(force: Bool = false) async {
        if let inflight { return await inflight.value }
        if !force, case .ready(_, let at) = issues, timers.now - at < Self.issuesMaxAge { return }
        let read = Task {
            await read()
            inflight = nil
        }
        inflight = read
        await read.value
    }

    private func read() async {
        if issues == nil { issues = .loading }
        let issuesRead = Task { try await caller.call(RPC.linearIssues) }
        let configuredRead = Task { try await caller.call(RPC.secretsHas, SecretsHasRequest(name: "linear.apiKey")) }
        let issuesResult = await issuesRead.result
        let configuredResult = await configuredRead.result
        let at = timers.now
        switch issuesResult {
        case .success(let list): issues = .ready(Overview.sortIssues(list), at: at)
        case .failure(let error): issues = .failure(error, at: at)
        }
        configured = try? configuredResult.get()
    }
}
