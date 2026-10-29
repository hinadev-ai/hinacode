import { randomUUID } from "node:crypto"
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { Deferred, Effect } from "effect"
import type { AgentEvent, ApprovalDecision, ApprovalKind, SessionScope } from "../../../shared/agent.ts"

export interface ApprovalSession {
  readonly threadId: string
  readonly sessionGrants: Set<string>
  readonly attachmentPaths: Set<string>
  readonly turn: object | null
}

interface PendingApproval {
  readonly session: ApprovalSession
  readonly scope: SessionScope
  readonly deferred: Deferred.Deferred<ApprovalDecision>
}

function approvalKind(toolName: string): ApprovalKind {
  if (toolName === "Bash") return "command"
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName)) return "patch"
  return "tool"
}

function approvalDetail(input: Record<string, unknown>): string {
  const summary = input.command ?? input.file_path ?? input.notebook_path ?? input.url
  return typeof summary === "string" ? summary : JSON.stringify(input)
}

function sessionScope(tool: string, input: Record<string, unknown>): SessionScope {
  if (typeof input.command === "string") return { tool, kind: "command", value: input.command }
  const path = input.file_path ?? input.notebook_path ?? input.path
  if (typeof path === "string") return { tool, kind: "path", value: path }
  if (typeof input.url === "string" && URL.canParse(input.url)) {
    return { tool, kind: "domain", value: new URL(input.url).hostname }
  }
  return { tool, kind: "tool", value: tool }
}

const grantKey = (scope: SessionScope) => JSON.stringify([scope.tool, scope.kind, scope.value])

export function makeApprovals<S extends ApprovalSession>(emit: (session: S, event: AgentEvent) => void) {
  const pending = new Map<string, PendingApproval>()

  const ask = async (
    session: S,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> => {
    const scope = sessionScope(toolName, input)
    if (session.sessionGrants.has(grantKey(scope))) return { behavior: "allow", updatedInput: input }
    if (toolName === "Read" && typeof input.file_path === "string" && session.attachmentPaths.has(input.file_path)) {
      return { behavior: "allow", updatedInput: input }
    }
    if (session.turn === null) return { behavior: "deny", message: "No active turn to approve this tool call" }

    const requestId = randomUUID()
    const deferred = Deferred.makeUnsafe<ApprovalDecision>()
    pending.set(requestId, { session, scope, deferred })
    const onAbort = () => Deferred.doneUnsafe(deferred, Effect.succeed("deny"))
    options.signal.addEventListener("abort", onAbort, { once: true })
    emit(session, {
      type: "approval_requested",
      request: {
        id: requestId,
        threadId: session.threadId,
        provider: "claude",
        kind: approvalKind(toolName),
        title: options.title ?? options.displayName ?? toolName,
        detail: options.description ?? approvalDetail(input),
        input,
        sessionScope: scope,
      },
    })

    const decision = await Effect.runPromise(Deferred.await(deferred))
    options.signal.removeEventListener("abort", onAbort)
    pending.delete(requestId)
    emit(session, { type: "approval_resolved", requestId })
    return decision === "deny"
      ? { behavior: "deny", message: "The user denied this tool call" }
      : { behavior: "allow", updatedInput: input }
  }

  const respond = (requestId: string, decision: ApprovalDecision) =>
    Effect.suspend(() => {
      const approval = pending.get(requestId)
      if (approval === undefined) return Effect.void
      if (decision === "allow_for_session") approval.session.sessionGrants.add(grantKey(approval.scope))
      return Deferred.succeed(approval.deferred, decision)
    })

  return { ask, respond }
}
