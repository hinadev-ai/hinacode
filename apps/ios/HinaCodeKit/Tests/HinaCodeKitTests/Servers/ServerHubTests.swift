import Foundation
import Testing

@testable import HinaCodeKit

private let early = "2026-10-24T00:00:00.000Z"

private func server(_ id: String, _ port: Int) -> StoredServer {
    StoredServer(id: id, hosts: ["127.0.0.1"], port: port, token: "t")
}

private func project(_ id: String) -> Project {
    Project(
        id: id, name: id, rootPath: "/srv/\(id)", createdAt: early, updatedAt: early, linearReview: false,
        kind: .folder)
}

private func thread(_ id: String, _ projectId: String) -> AgentThread {
    AgentThread(
        id: id, projectId: projectId, title: id, provider: .claude, model: "sonnet", fastMode: false,
        userSkills: false, accessMode: .supervised, status: .idle, sortIndex: 0, queue: [], createdBy: "user",
        createdAt: early, updatedAt: early)
}

private func json<Value: Encodable>(_ value: Value) -> String {
    String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
}

@MainActor
final class HubSockets {
    private(set) var all: [FakeSocket] = []

    func make(_ url: URL) -> SocketLike {
        let socket = FakeSocket(url: url, token: "t")
        all.append(socket)
        return socket
    }

    func socket(port: Int) -> FakeSocket {
        all.last { $0.url.contains(":\(port)/") }!
    }
}

@MainActor
@Suite("ServerHub")
struct ServerHubTests {
    let timers = ManualTimers()
    let sockets = HubSockets()
    let hub: ServerHub

    init() {
        let sockets = sockets
        hub = ServerHub(storage: MemoryServerStorage(), timers: timers, createSocket: { sockets.make($0) })
        hub.setServers([server("a", 1001), server("b", 1002)])
        sockets.socket(port: 1001).handshake(
            ["call-keys"], environment: ServerIdentity(id: "env-a", name: "studio"))
        sockets.socket(port: 1002).handshake(
            ["call-keys"], environment: ServerIdentity(id: "env-b", name: "home-server"))
    }

    private func flush() async {
        for _ in 0..<100 { await Task.yield() }
    }

    private func finish() {
        hub.setServers([])
    }

    @Test("merges every server's projects and marks each with its server")
    func mergesProjects() async throws {
        let hub = hub
        let listing = Task { try await hub.call(RPC.projectsList) }
        await flush()
        sockets.socket(port: 1001).answer("projects.list", json([project("web")]))
        sockets.socket(port: 1002).answer("projects.list", json([project("api")]))
        let projects = try await listing.value
        #expect(projects.map { [$0.name, $0.environmentId] } == [["web", "a"], ["api", "b"]])
        finish()
    }

    @Test("sends a thread's call to the server that listed it")
    func sendsToOwner() async throws {
        let hub = hub
        let listing = Task { try await hub.call(RPC.threadsList) }
        await flush()
        sockets.socket(port: 1001).answer("threads.list", json([thread("t-web", "web")]))
        sockets.socket(port: 1002).answer("threads.list", json([thread("t-api", "api")]))
        _ = try await listing.value

        let sending = Task {
            _ = try? await hub.call(RPC.threadsSend, ThreadsSendRequest(threadId: "t-api", prompt: "hi"))
        }
        await flush()
        #expect(sockets.socket(port: 1001).calls("threads.send").isEmpty)
        #expect(sockets.socket(port: 1002).calls("threads.send").count == 1)
        finish()
        await sending.value
    }

    @Test("waits for the lists before routing an id no server has claimed")
    func waitsForLists() async throws {
        let hub = hub
        let transcript = Task {
            _ = try? await hub.call(RPC.threadsTranscript, ThreadsTranscriptRequest(threadId: "t-api"))
        }
        await flush()
        #expect(sockets.socket(port: 1002).calls("threads.transcript").isEmpty)

        let listing = Task { try await hub.call(RPC.threadsList) }
        await flush()
        sockets.socket(port: 1001).answer("threads.list", json([AgentThread]()))
        sockets.socket(port: 1002).answer("threads.list", json([thread("t-api", "api")]))
        _ = try await listing.value
        await flush()
        #expect(sockets.socket(port: 1002).calls("threads.transcript").count == 1)
        finish()
        await transcript.value
    }

    @Test("lists an offline server's last answer without waiting for it")
    func listsOfflineAnswer() async throws {
        let hub = hub
        let first = Task { try await hub.call(RPC.projectsList) }
        await flush()
        sockets.socket(port: 1001).answer("projects.list", json([project("web")]))
        sockets.socket(port: 1002).answer("projects.list", json([project("api")]))
        _ = try await first.value

        sockets.socket(port: 1002).drop(1006)
        #expect(hub.servers.map(\.status) == [.connected, .offline])
        #expect(hub.status == .connected)

        let second = Task { try await hub.call(RPC.projectsList) }
        await flush()
        sockets.socket(port: 1001).answer("projects.list", json([project("web"), project("docs")]))
        let projects = try await second.value
        #expect(projects.map(\.name) == ["web", "docs", "api"])
        finish()
    }

    @Test("sends a named call to the server it names")
    func sendsNamed() async {
        let hub = hub
        let creating = Task {
            _ = try? await hub.call(
                RPC.projectsCreate, ProjectsCreateRequest(name: "api", rootPath: "/srv/api"), server: "b")
        }
        await flush()
        #expect(sockets.socket(port: 1001).calls("projects.create").isEmpty)
        #expect(sockets.socket(port: 1002).calls("projects.create").count == 1)
        finish()
        await creating.value
    }

    @Test("names each server after its first handshake")
    func namesServers() {
        #expect(hub.servers.map { [$0.name, $0.environmentId] } == [["studio", "env-a"], ["home-server", "env-b"]])
        finish()
    }

    @Test("keeps one entry when the same machine is paired again at another address")
    func keepsOneEntry() {
        hub.setServers(hub.storedServers() + [server("c", 1003)])
        sockets.socket(port: 1003).handshake(environment: ServerIdentity(id: "env-a", name: "studio"))
        #expect(hub.servers.map(\.id) == ["b", "c"])
        finish()
    }

    @Test("dials the hosts at once and the relay after them")
    func dialsRelayAfterHosts() {
        var c = server("c", 1003)
        c.relay = "c.example.com"
        hub.setServers(hub.storedServers() + [c])
        #expect(sockets.all.last?.url == "ws://127.0.0.1:1003/remote")
        timers.advance(by: Remote.relayDelay)
        #expect(sockets.all.last?.url == "wss://c.example.com/remote")
        finish()
    }

    @Test("learns a relay from the handshake without dropping the socket or its calls")
    func learnsRelay() async throws {
        let hub = hub
        hub.setServers(hub.storedServers() + [server("c", 1003)])
        let creating = Task {
            try await hub.call(
                RPC.projectsCreate, ProjectsCreateRequest(name: "api", rootPath: "/srv/api"), server: "c")
        }
        await flush()
        let direct = sockets.socket(port: 1003)
        direct.handshake(environment: ServerIdentity(id: "env-c", name: "laptop"), relay: "c.example.com")
        #expect(hub.servers.first { $0.id == "c" }?.relay == "c.example.com")
        #expect(sockets.all.last === direct)

        direct.answer("projects.create", json(project("api")))
        let created = try await creating.value
        #expect(created.name == "api")

        direct.drop(1006)
        hub.reconnectNow(id: "c")
        #expect(sockets.all.last !== direct)
        #expect(sockets.all.last?.url == "ws://127.0.0.1:1003/remote")
        timers.advance(by: Remote.relayDelay)
        #expect(sockets.all.last?.url == "wss://c.example.com/remote")
        finish()
    }
}
