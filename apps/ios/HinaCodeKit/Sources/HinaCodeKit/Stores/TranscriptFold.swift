/// Applies one agent event to the assistant message of the running turn, as the desktop's `src/shared/foldEvent.ts`
/// does, so the live copy agrees with what the desktop persists. Events that do not touch the transcript
/// (session_bound, approvals) return the message unchanged.
func foldEvent(_ message: Message, _ event: AgentEvent, now: String) -> Message {
    var message = message
    switch event {
    case .textDelta(let delta):
        appendText(&message.parts, .text, delta.text)
    case .reasoningDelta(let delta):
        appendText(&message.parts, .reasoning, delta.text)
    case .toolCallStarted(let call):
        message.parts.append(
            .toolCall(
                .init(
                    callId: call.callId, name: call.name, input: call.input, status: .running,
                    parentCallId: call.parentCallId)))
    case .toolCallFinished(let result):
        message.parts = message.parts.map { part in
            guard case .toolCall(var call) = part, call.callId == result.callId else { return part }
            call.output = result.output
            call.status = result.isError ? .error : .done
            return .toolCall(call)
        }
    case .fileChanged(let change):
        message.parts.append(.fileChange(.init(path: change.path, diff: change.diff ?? "")))
    case .questionsPosted(let posted):
        message.parts.append(.questions(.init(text: posted.text, questions: posted.questions)))
    case .compactionUpdated(let update):
        let part = MessagePart.compaction(.init(compaction: update.compaction))
        if let running = message.parts.lastIndex(where: isRunningCompaction) {
            message.parts[running] = part
        } else {
            message.parts.append(part)
        }
    case .turnCompleted(let turn):
        message.parts = failRunningParts(message.parts)
        message.completedAt = now
        message.usage = turn.usage
    case .turnFailed(let turn):
        message.parts = failRunningParts(message.parts) + [.text(.init(text: "**Error:** \(turn.message)"))]
        message.completedAt = now
    case .turnLimited(let turn):
        message.parts = failRunningParts(message.parts)
        if let explanation = limitMessage(turn.limit) { message.parts.append(.text(.init(text: explanation))) }
        message.completedAt = now
    case .sessionBound, .approvalRequested, .approvalResolved, .questionRequested, .questionResolved,
        .subagentUpdated, .secretRequested, .secretResolved, .unknown:
        break
    }
    return message
}

/// Applies one agent event to a transcript whose running turn may span several assistant messages (a steer closes the
/// current one and opens another). Tool results go to the message holding the call; everything else goes to the
/// latest assistant message. When the turn ends, tool calls left running in earlier messages fail too.
func foldTranscript(_ messages: [Message], _ event: AgentEvent, now: String) -> [Message] {
    guard let latest = messages.lastIndex(where: { $0.role == .assistant }) else { return messages }
    let target: Int?
    if case .toolCallFinished(let result) = event {
        target = messages.lastIndex { message in message.parts.contains { isToolCall($0, result.callId) } }
    } else {
        target = latest
    }
    guard let target else { return messages }

    var next = messages
    next[target] = foldEvent(messages[target], event, now: now)
    if endsTurn(event) {
        for index in next.indices where index != target {
            next[index].parts = failRunningParts(next[index].parts)
        }
    }
    return next
}

private func endsTurn(_ event: AgentEvent) -> Bool {
    switch event {
    case .turnCompleted, .turnFailed, .turnLimited: true
    default: false
    }
}

private func isToolCall(_ part: MessagePart, _ callId: String) -> Bool {
    guard case .toolCall(let call) = part else { return false }
    return call.callId == callId
}

private func isRunningCompaction(_ part: MessagePart) -> Bool {
    guard case .compaction(let part) = part, case .running = part.compaction else { return false }
    return true
}

/// A turn that ended (interrupted, failed) while tools or a compaction ran will never report their results.
private func failRunningParts(_ parts: [MessagePart]) -> [MessagePart] {
    parts.map { part in
        if case .toolCall(var call) = part, call.status == .running {
            call.status = .error
            return .toolCall(call)
        }
        if isRunningCompaction(part) { return .compaction(.init(compaction: .failed(.init(message: nil)))) }
        return part
    }
}

private func limitMessage(_ limit: AgentEvent.TurnLimited.Limit) -> String? {
    switch limit {
    case .usage(let usage): usage.message
    case .orgSpend(let spend): spend.message
    case .unknown: nil
    }
}

private enum TextKind {
    case text, reasoning
}

/// Deltas extend the trailing part of the same kind, so one streamed paragraph stays one part.
private func appendText(_ parts: inout [MessagePart], _ kind: TextKind, _ text: String) {
    switch (kind, parts.last) {
    case (.text, .text(let last)?):
        parts[parts.count - 1] = .text(.init(text: last.text + text))
    case (.reasoning, .reasoning(let last)?):
        parts[parts.count - 1] = .reasoning(.init(text: last.text + text))
    case (.text, _):
        parts.append(.text(.init(text: text)))
    case (.reasoning, _):
        parts.append(.reasoning(.init(text: text)))
    }
}
