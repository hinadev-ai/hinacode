import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { AccountHome, AccountProviderId } from "../../shared/agent.ts"
import type { ExternalSession, Message, Thread } from "../../shared/domain.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { AgentError, type AgentProvider } from "../agents/provider.ts"
import { AgentAccounts } from "./AgentAccounts.ts"
import { type NotFoundError, type PersistenceError, persistence, type WorktreeTakenError } from "./errors.ts"
import { Messages } from "./Messages.ts"
import { Projects } from "./Projects.ts"
import { Settings } from "./Settings.ts"
import { Threads } from "./Threads.ts"
import type { CommandError } from "./Git.ts"

export interface ExternalSessionList {
  readonly sessions: ReadonlyArray<ExternalSession>
  readonly failures: ReadonlyArray<{
    readonly provider: AccountProviderId
    readonly accountId: string | null
    readonly message: string
  }>
}

export interface ImportSession {
  readonly projectId: string
  readonly provider: AccountProviderId
  readonly sessionId: string
  readonly accountId: string | null
}

const providerNames: Record<AccountProviderId, string> = { claude: "Claude Code", codex: "Codex" }

export class SessionImports extends Context.Service<
  SessionImports,
  {
    readonly list: (projectId: string) => Effect.Effect<ExternalSessionList, PersistenceError | NotFoundError>
    readonly import: (
      input: ImportSession,
    ) => Effect.Effect<Thread, AgentError | PersistenceError | NotFoundError | CommandError | WorktreeTakenError>
  }
>()("hinacode/SessionImports") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* Projects
  const threads = yield* Threads
  const messages = yield* Messages
  const accounts = yield* AgentAccounts
  const settings = yield* Settings
  const providers: Record<AccountProviderId, AgentProvider> = {
    claude: yield* ClaudeProvider,
    codex: yield* CodexProvider,
  }

  const homes = Effect.gen(function* () {
    const added = yield* accounts.list
    return (["claude", "codex"] as const).flatMap((provider) => [
      { provider, accountId: null },
      ...added.flatMap((account) => (account.provider === provider ? [{ provider, accountId: account.id }] : [])),
    ])
  })

  const folderOf = (projectId: string) =>
    Effect.gen(function* () {
      const project = yield* projects.get(projectId)
      if (project.kind !== "folder") {
        return yield* new AgentError({ provider: "hinacode", message: "Sessions import into folder projects only" })
      }
      return project.rootPath
    })

  const boundThreads = threads.list.pipe(
    Effect.map(
      (all) =>
        new Map(
          all.flatMap((thread) =>
            thread.providerSessionId === null ? [] : [[`${thread.provider}:${thread.providerSessionId}`, thread]],
          ),
        ),
    ),
  )

  const list = (projectId: string) =>
    Effect.gen(function* () {
      const project = yield* projects.get(projectId)
      if (project.kind !== "folder") return { sessions: [], failures: [] }
      const bound = yield* boundThreads
      const results = yield* Effect.forEach(
        yield* homes,
        ({ provider, accountId }) =>
          Effect.gen(function* () {
            const listSessions = providers[provider].listSessions
            if (listSessions === undefined) return []
            const found = yield* listSessions(project.rootPath, yield* accounts.home(accountId))
            return found.map((session): ExternalSession => ({
              ...session,
              provider,
              accountId,
              threadId: bound.get(`${provider}:${session.sessionId}`)?.id ?? null,
            }))
          }).pipe(
            Effect.map((sessions) => ({ sessions, failure: null })),
            Effect.catch((error) =>
              Effect.succeed({ sessions: [], failure: { provider, accountId, message: error.message } }),
            ),
          ),
        { concurrency: "unbounded" },
      )
      const newest = new Map<string, ExternalSession>()
      for (const session of results.flatMap((result) => result.sessions)) {
        const key = `${session.provider}:${session.sessionId}`
        const seen = newest.get(key)
        if (seen === undefined || session.updatedAt > seen.updatedAt) newest.set(key, session)
      }
      return {
        sessions: [...newest.values()].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        failures: results.flatMap((result) => (result.failure === null ? [] : [result.failure])),
      }
    })

  const defaultModel = (provider: AccountProviderId) =>
    Effect.gen(function* () {
      const chosen = (yield* settings.get).defaultModel[provider]
      if (chosen !== null) return chosen
      const models = yield* providers[provider].listModels.pipe(Effect.orElseSucceed(() => []))
      return models[0]?.id ?? ""
    })

  const read = (provider: AccountProviderId, sessionId: string, cwd: string, home: AccountHome | null) => {
    const readSession = providers[provider].readSession
    return readSession === undefined
      ? Effect.fail(new AgentError({ provider, message: `${providerNames[provider]} sessions can't be imported` }))
      : readSession(sessionId, cwd, home)
  }

  const importSession = ({ projectId, provider, sessionId, accountId }: ImportSession) =>
    Effect.gen(function* () {
      const existing = (yield* boundThreads).get(`${provider}:${sessionId}`)
      if (existing !== undefined) return existing
      const cwd = yield* folderOf(projectId)
      if (accountId !== null && (yield* accounts.get(accountId)).provider !== provider) {
        return yield* new AgentError({ provider, message: "That account belongs to another agent" })
      }
      const history = yield* read(provider, sessionId, cwd, yield* accounts.home(accountId))
      const model = history.model ?? (yield* defaultModel(provider))
      const firstPrompt = history.messages
        ?.find((message) => message.role === "user")
        ?.parts.find((part) => part.type === "text")
      const title =
        history.title ??
        (firstPrompt?.type === "text" ? firstPrompt.text.split("\n")[0]!.slice(0, 80) : "Imported session")

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const created = yield* threads.create({ projectId, title, provider, model })
            const thread = yield* threads.update({ id: created.id, accountId, providerSessionId: sessionId })
            const replayed = history.messages ?? []
            const lastAt = replayed.at(-1)?.completedAt ?? replayed.at(-1)?.createdAt ?? thread.createdAt
            const rule: Message = {
              id: randomUUID(),
              threadId: thread.id,
              role: "assistant",
              parts: [
                { type: "session_import", provider, history: history.messages === null ? "unavailable" : "replayed" },
              ],
              createdAt: lastAt,
              completedAt: lastAt,
              usage: null,
              forkPoint: null,
            }
            yield* Effect.forEach(
              [
                ...replayed.map((message): Message => ({
                  ...message,
                  id: randomUUID(),
                  threadId: thread.id,
                  usage: null,
                })),
                rule,
              ],
              messages.insert,
              { discard: true },
            )
            return thread
          }),
        )
        .pipe(Effect.mapError((error) => (error._tag === "SqlError" ? persistence("sessions.import")(error) : error)))
    })

  return SessionImports.of({ list, import: importSession })
})

export const layer = Layer.effect(SessionImports, make)
