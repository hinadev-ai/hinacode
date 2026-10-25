import Foundation

/// Which server owns an id. Only claimed ids are recorded. Ids are UUIDs except roots, which are paths, so two
/// machines with the same checkout path both claim it and the last one wins.
@MainActor
final class Owners {
    private var index: [String: String] = [:]

    func teach(_ serverId: String, _ entity: Entity, _ id: String) {
        index["\(entity.rawValue):\(id)"] = serverId
    }

    func owner(_ entity: Entity, _ id: String) -> String? {
        index["\(entity.rawValue):\(id)"]
    }

    func forget(_ serverId: String) {
        index = index.filter { $0.value != serverId }
    }

    /// Teaches the ids in a server's decoded answer to `method`.
    func learn(serverId: String, method: String, result: any Sendable) {
        switch method {
        case "projects.list", "projects.create", "projects.clone", "projects.update":
            forEach(result, as: Project.self) { project in
                teach(serverId, .project, project.id)
                teach(serverId, .root, project.rootPath)
            }
        case "threads.list", "threads.create", "threads.update", "threads.archive", "threads.unarchive":
            forEach(result, as: AgentThread.self) { teach(serverId, .thread, $0.id) }
        case "worktrees.list", "worktrees.create":
            forEach(result, as: Worktree.self) { worktree in
                teach(serverId, .worktree, worktree.id)
                teach(serverId, .root, worktree.path)
            }
        case "terminal.open", "terminal.list":
            forEach(result, as: TerminalSession.self) { teach(serverId, .terminal, $0.id) }
        case "threads.transcript":
            guard let transcript = result as? ThreadsTranscriptResponse else { return }
            for request in transcript.approvals { teach(serverId, .request, request.id) }
            for request in transcript.questions { teach(serverId, .request, request.id) }
            for request in transcript.secretRequests { teach(serverId, .request, request.id) }
        default:
            break
        }
    }

    /// Teaches the ids in a push a server sent.
    func learn(serverId: String, fromPush event: PushEvent) {
        switch event {
        case .threadUpdated(let update):
            teach(serverId, .thread, update.thread.id)
        case .worktreeUpdated(let update):
            teach(serverId, .worktree, update.worktree.id)
            teach(serverId, .root, update.worktree.path)
        case .terminalData(let data):
            teach(serverId, .terminal, data.id)
        case .terminalExited(let exited):
            teach(serverId, .terminal, exited.id)
        case .threadEvent(let threadEvent):
            teach(serverId, .thread, threadEvent.threadId)
            switch threadEvent.event {
            case .approvalRequested(let requested): teach(serverId, .request, requested.request.id)
            case .questionRequested(let requested): teach(serverId, .request, requested.request.id)
            case .secretRequested(let requested): teach(serverId, .request, requested.request.id)
            default: break
            }
        default:
            break
        }
    }

    /// Runs `learn` on a result that is one value or a list of them, as answers come in both shapes.
    private func forEach<Value>(_ result: any Sendable, as type: Value.Type, _ learn: (Value) -> Void) {
        if let list = result as? [Value] {
            list.forEach(learn)
        } else if let one = result as? Value {
            learn(one)
        }
    }
}

/// Answers that carry projects, which a client stamps with the server they came from.
private let projectAnswers: Set<String> = ["projects.list", "projects.create", "projects.clone", "projects.update"]

/// `result` with each project in an answer to `method` marked as `serverId`'s, to show where it lives.
func stampProjects<Response>(method: String, result: Response, serverId: String) -> Response {
    guard projectAnswers.contains(method) else { return result }
    if var project = result as? Project {
        project.environmentId = serverId
        return (project as? Response) ?? result
    }
    if var projects = result as? [Project] {
        for index in projects.indices { projects[index].environmentId = serverId }
        return (projects as? Response) ?? result
    }
    return result
}
