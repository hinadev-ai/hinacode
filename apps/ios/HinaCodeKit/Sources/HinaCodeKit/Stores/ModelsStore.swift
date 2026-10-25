import Observation

/// The models each agent offers on each server, read once for the life of the app like the desktop's `modelsAtom`.
@MainActor
@Observable
public final class ModelsStore {
    /// By server id, since each machine has its own agents and accounts. `""` is a call that named no server.
    public private(set) var byServer: [String: [ProviderId: [ModelInfo]]] = [:]

    @ObservationIgnored private let caller: any Caller
    @ObservationIgnored private var inflight: [Key: Task<Void, any Error>] = [:]

    public init(caller: any Caller) {
        self.caller = caller
    }

    /// The models `provider` offers on `server`, once loaded.
    public func models(server: String?, provider: ProviderId) -> [ModelInfo]? {
        byServer[server ?? ""]?[provider]
    }

    /// Reads a provider's models on `server` once. Concurrent calls share one read. Throws when the server could not
    /// list them, and a later call tries again.
    public func load(server: String?, provider: ProviderId) async throws {
        let serverKey = server ?? ""
        if byServer[serverKey]?[provider] != nil { return }
        let key = Key(server: serverKey, provider: provider)
        if let pending = inflight[key] { return try await pending.value }
        let read = Task {
            defer { inflight[key] = nil }
            let models = try await caller.call(RPC.modelsList, ModelsListRequest(provider: provider), server: server)
            byServer[serverKey, default: [:]][provider] = models
        }
        inflight[key] = read
        try await read.value
    }

    private struct Key: Hashable {
        let server: String
        let provider: ProviderId
    }
}
