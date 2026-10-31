import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { AccountHome, ProviderId } from "../../shared/agent.ts"
import type { MessagePart } from "../../shared/domain.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { listClaudeSessions, readClaudeSession } from "../agents/claude/sessions.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { AgentError, type AgentProvider, type ImportedMessage, type SessionHistory } from "../agents/provider.ts"
import * as Db from "../db/client.ts"
import { AgentAccounts, layer as accountsLayer } from "./AgentAccounts.ts"
import * as Attachments from "./Attachments.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import { Messages, layer as messagesLayer } from "./Messages.ts"
import { Projects, layer as projectsLayer } from "./Projects.ts"
import { SessionImports, layer as importsLayer } from "./SessionImports.ts"
import { layer as settingsLayer } from "./Settings.ts"
import * as Scratch from "./Scratch.ts"
import * as Terminals from "./Terminals.ts"
import { Threads, layer as threadsLayer } from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"

const fixture = readFileSync(join(import.meta.dirname, "../agents/claude/fixtures/session.jsonl"), "utf8")
const fixtureId = "87d0f8e9-8061-47d3-a18a-736d868a56a4"
const fixtureCwd = "/work/fruit-shop"

const unused = () => Effect.die("not used by session import")

const providers = (cliHome: string, options: { history?: SessionHistory } = {}) => {
  const fake = (id: ProviderId, overrides: Partial<AgentProvider>): AgentProvider => ({
    id,
    listModels: Effect.succeed([]),
    account: unused,
    planLimits: unused,
    usage: unused,
    listCommands: unused,
    runTurn: unused as never,
    steer: unused,
    interrupt: unused,
    setAccessMode: unused,
    respondApproval: unused,
    respondQuestion: unused,
    ...overrides,
  })
  const dir = (home: AccountHome | null) => home?.dir ?? cliHome
  return Layer.mergeAll(
    Layer.succeed(
      ClaudeProvider,
      fake("claude", {
        listSessions: (cwd, home) => Effect.promise(() => listClaudeSessions(dir(home), cwd)),
        readSession: (sessionId, cwd, home) =>
          options.history
            ? Effect.succeed(options.history)
            : Effect.tryPromise({
                try: () => readClaudeSession(dir(home), cwd, sessionId),
                catch: (cause) => new AgentError({ provider: "claude", message: String(cause) }),
              }),
      }),
    ),
    Layer.succeed(
      CodexProvider,
      fake("codex", {
        listSessions: () => Effect.fail(new AgentError({ provider: "codex", message: "codex is not installed" })),
      }),
    ),
  )
}

const writeSession = (home: string, cwd: string, mtime: Date) => {
  const dir = join(home, "projects", cwd.replaceAll("/", "-"))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${fixtureId}.jsonl`)
  writeFileSync(file, fixture.replaceAll(fixtureCwd, cwd))
  utimesSync(file, mtime, mtime)
}

const setup = (options: { history?: SessionHistory } = {}) => {
  const cliHome = mkdtempSync(join(tmpdir(), "kk-import-cli-home-"))
  const layer = importsLayer.pipe(
    Layer.provideMerge(
      threadsLayer.pipe(
        Layer.provide(Terminals.layer),
        Layer.provideMerge(Worktrees.layer),
        Layer.provideMerge(projectsLayer),
        Layer.provideMerge(accountsLayer),
        Layer.provideMerge(settingsLayer(mkdtempSync(join(tmpdir(), "kk-import-settings-")))),
        Layer.provideMerge(Scratch.layer(mkdtempSync(join(tmpdir(), "kk-scratch-")))),
      ),
    ),
    Layer.provideMerge(messagesLayer),
    Layer.provide(Attachments.layer(mkdtempSync(join(tmpdir(), "kk-import-attachments-")))),
    Layer.provide(providers(cliHome, options)),
    Layer.provide(
      Layer.mergeAll(Git.layer, GitHub.layer).pipe(
        Layer.provideMerge(Layer.succeed(Events, { publish: () => Effect.void })),
      ),
    ),
    Layer.provideMerge(Db.layer(":memory:")),
    Layer.provide(NodeServices.layer),
  )
  const project = Projects.use((projects) =>
    projects.create({
      name: "fruit-shop",
      rootPath: mkdtempSync(join(tmpdir(), "kk-import-project-")),
      setupScript: null,
    }),
  )
  return { cliHome, layer, project }
}

const partTypes = (parts: ReadonlyArray<MessagePart>) => parts.map((part) => part.type)

describe("session import", () => {
  it.effect("reuses one thread when the same session is imported twice at once", () => {
    const { cliHome, layer, project } = setup()
    return Effect.gen(function* () {
      const { id, rootPath } = yield* project
      writeSession(cliHome, rootPath, new Date("2026-10-01T00:00:00Z"))
      const imports = yield* SessionImports
      const request = { projectId: id, provider: "claude" as const, sessionId: fixtureId, accountId: null }
      const imported = yield* Effect.all([imports.import(request), imports.import(request)], {
        concurrency: "unbounded",
      })
      expect(imported[0].id).toBe(imported[1].id)
      expect(yield* Threads.use((threads) => threads.list)).toHaveLength(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("lists the newest copy of each session and reports a home that can't be read", () => {
    const { cliHome, layer, project } = setup()
    return Effect.gen(function* () {
      const { id, rootPath } = yield* project
      const accountHome = mkdtempSync(join(tmpdir(), "kk-import-account-home-"))
      const account = yield* AgentAccounts.use((accounts) =>
        accounts.create({ provider: "claude", name: "Work", configDir: accountHome, binary: "claude" }),
      )
      writeSession(cliHome, rootPath, new Date("2026-10-01T00:00:00Z"))
      writeSession(accountHome, rootPath, new Date("2026-10-02T00:00:00Z"))
      writeSession(cliHome, `${rootPath}-other`, new Date("2026-10-03T00:00:00Z"))

      const listed = yield* SessionImports.use((imports) => imports.list(id))
      expect(listed.sessions).toStrictEqual([
        {
          provider: "claude",
          sessionId: fixtureId,
          accountId: account.id,
          title: "Stock.txt fruit list",
          preview: expect.stringContaining("Create a file stock.txt"),
          branch: "main",
          updatedAt: "2026-10-02T00:00:00.000Z",
          threadId: null,
        },
      ])
      expect(listed.failures).toStrictEqual([{ provider: "codex", accountId: null, message: "codex is not installed" }])
    }).pipe(Effect.provide(layer))
  })

  it.effect("binds a thread in the project root to the session and replays every message", () => {
    const { cliHome, layer, project } = setup()
    return Effect.gen(function* () {
      const { id, rootPath } = yield* project
      writeSession(cliHome, rootPath, new Date("2026-10-01T00:00:00Z"))
      const imports = yield* SessionImports
      const thread = yield* imports.import({ projectId: id, provider: "claude", sessionId: fixtureId, accountId: null })

      expect(thread).toMatchObject({
        title: "Stock.txt fruit list",
        provider: "claude",
        model: "claude-haiku-5-5",
        accountId: null,
        providerSessionId: fixtureId,
        worktreeId: null,
        status: "idle",
      })
      const messages = yield* Messages.use((service) => service.list(thread.id))
      expect(messages.map((message) => [message.role, partTypes(message.parts)])).toStrictEqual([
        ["user", ["text"]],
        ["assistant", ["tool_call", "file_change", "text"]],
        ["user", ["text"]],
        ["assistant", ["tool_call", "text"]],
        ["assistant", ["session_import"]],
      ])
      expect(messages.at(-1)?.parts[0]).toStrictEqual({
        type: "session_import",
        provider: "claude",
        history: "replayed",
      })

      const again = yield* imports.import({ projectId: id, provider: "claude", sessionId: fixtureId, accountId: null })
      expect(again.id).toBe(thread.id)
      expect((yield* imports.list(id)).sessions[0]?.threadId).toBe(thread.id)
      expect(yield* Threads.use((threads) => threads.list)).toHaveLength(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("says so when the history can't be read, instead of inventing it", () => {
    const { layer, project } = setup({ history: { title: null, model: null, messages: null } })
    return Effect.gen(function* () {
      const { id } = yield* project
      const thread = yield* SessionImports.use((imports) =>
        imports.import({ projectId: id, provider: "claude", sessionId: fixtureId, accountId: null }),
      )
      expect(thread).toMatchObject({ title: "Imported session", providerSessionId: fixtureId })
      const messages = yield* Messages.use((service) => service.list(thread.id))
      expect(messages.map((message) => message.parts)).toStrictEqual([
        [{ type: "session_import", provider: "claude", history: "unavailable" }],
      ])
    }).pipe(Effect.provide(layer))
  })

  const imagePrompt = (images: NonNullable<ImportedMessage["images"]>): SessionHistory => ({
    title: "Shapes",
    model: "claude-opus-5-5",
    messages: [
      { role: "user", parts: [], images, createdAt: "2026-10-01T00:00:00.000Z", completedAt: null, forkPoint: null },
      {
        role: "assistant",
        parts: [{ type: "text", text: "A red square." }],
        createdAt: "2026-10-01T00:00:01.000Z",
        completedAt: "2026-10-01T00:00:02.000Z",
        forkPoint: null,
      },
    ],
  })

  it.effect("stores the images a replayed prompt carried", () => {
    const { layer, project } = setup({
      history: imagePrompt([{ dataUrl: "data:image/png;base64,aW1n", name: "image.png" }]),
    })
    return Effect.gen(function* () {
      const { id } = yield* project
      const thread = yield* SessionImports.use((imports) =>
        imports.import({ projectId: id, provider: "claude", sessionId: fixtureId, accountId: null }),
      )
      const [prompt] = yield* Messages.use((service) => service.list(thread.id))
      const [part] = prompt?.parts ?? []
      expect(part).toMatchObject({ type: "attachment", attachment: { kind: "image", mime: "image/png", bytes: 3 } })
      expect(part?.type === "attachment" && readFileSync(part.attachment.path, "utf8")).toBe("img")
    }).pipe(Effect.provide(layer))
  })

  it.effect("says the history is unavailable when a replayed image is gone", () => {
    const { layer, project } = setup({ history: imagePrompt([{ path: join(tmpdir(), "kk-import-gone.png") }]) })
    return Effect.gen(function* () {
      const { id } = yield* project
      const thread = yield* SessionImports.use((imports) =>
        imports.import({ projectId: id, provider: "claude", sessionId: fixtureId, accountId: null }),
      )
      const messages = yield* Messages.use((service) => service.list(thread.id))
      expect(messages.map((message) => message.parts)).toStrictEqual([
        [{ type: "session_import", provider: "claude", history: "unavailable" }],
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("leaves no thread behind for a session that vanished", () => {
    const { layer, project } = setup()
    return Effect.gen(function* () {
      const { id } = yield* project
      const error = yield* Effect.flip(
        SessionImports.use((imports) =>
          imports.import({ projectId: id, provider: "claude", sessionId: fixtureId, accountId: null }),
        ),
      )
      expect(error.message).toContain("no longer")
      expect(yield* Threads.use((threads) => threads.list)).toStrictEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("rolls the thread back when a message fails to write", () => {
    const unwritable = { type: "file_change", path: 1, diff: "" } as unknown as MessagePart
    const history: SessionHistory = {
      title: null,
      model: "claude-opus-5-5",
      messages: [
        {
          role: "user",
          parts: [unwritable],
          createdAt: "2026-10-01T00:00:00.000Z",
          completedAt: null,
          forkPoint: null,
        },
      ],
    }
    const { layer, project } = setup({ history })
    return Effect.gen(function* () {
      const { id } = yield* project
      yield* Effect.flip(
        SessionImports.use((imports) =>
          imports.import({ projectId: id, provider: "claude", sessionId: fixtureId, accountId: null }),
        ),
      )
      expect(yield* Threads.use((threads) => threads.list)).toStrictEqual([])
    }).pipe(Effect.provide(layer))
  })
})
