import { createServer } from "node:net"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Random, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import type { AgentEvent } from "../../../shared/agent.ts"
import type { PushEvent } from "../../../shared/contract.ts"
import { ClaudeProvider } from "../../agents/claude/index.ts"
import { CodexProvider } from "../../agents/codex/index.ts"
import type { AgentProvider } from "../../agents/provider.ts"
import * as Db from "../../db/client.ts"
import { seedThread } from "../../db/testing.ts"
import { McpCredentials, layer as credentialsLayer } from "../../mcp/credentials.ts"
import { LINEAR_API_KEY_SECRET } from "../../mcp/index.ts"
import * as AgentRunner from "../AgentRunner.ts"
import { Events } from "../Events.ts"
import * as Git from "../Git.ts"
import * as GitHub from "../GitHub.ts"
import * as Messages from "../Messages.ts"
import * as Projects from "../Projects.ts"
import * as Secrets from "../Secrets.ts"
import * as Settings from "../Settings.ts"
import * as ThreadNaming from "../ThreadNaming.ts"
import * as Threads from "../Threads.ts"
import * as Worktrees from "../Worktrees.ts"
import { Automations, layer as automationsLayer } from "./Automations.ts"
import type { LinearIssueFilter, LinearIssueNode } from "./pollers.ts"

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

const linear = vi.hoisted(() => ({
  issues: [] as Array<LinearIssueNode>,
  filters: [] as Array<LinearIssueFilter>,
}))

// Only the external Linear transport is scripted; polling and cursor persistence run unchanged.
vi.mock("@linear/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@linear/sdk")>()),
  LinearClient: class {
    async issues({ filter }: { readonly filter: LinearIssueFilter }) {
      linear.filters.push(filter)
      return { nodes: linear.issues.filter((issue) => issue.createdAt > filter.createdAt.gt) }
    }
  },
}))

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([]),
  listCommands: () => Effect.succeed([]),
  runTurn: () => Stream.fromIterable<AgentEvent>([{ type: "turn_completed" }]),
  steer: () => Effect.void,
  interrupt: () => Effect.void,
  respondApproval: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const unusedPort = Effect.promise(async () => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  if (address === null || typeof address === "string") throw new Error("Expected a TCP server address")
  return address.port
})

const makeLayer = (pushes: Array<PushEvent>, port: number) => {
  const domain = Layer.mergeAll(
    Threads.layer.pipe(Layer.provideMerge(Worktrees.layer), Layer.provideMerge(Projects.layer)),
    Messages.layer,
    Settings.layer,
    Secrets.layer,
    credentialsLayer,
  )
  const agents = AgentRunner.layer.pipe(
    Layer.provideMerge(ThreadNaming.layer.pipe(Layer.provide(domain))),
    Layer.provideMerge(domain),
  )
  const database = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO setting (key, value) VALUES ('automations', ${JSON.stringify({ bindHost: "127.0.0.1", port })})`
    }),
  ).pipe(Layer.provideMerge(Db.layer(":memory:")))
  return automationsLayer.pipe(
    Layer.provideMerge(agents),
    Layer.provide(
      Layer.mergeAll(
        Git.layer,
        GitHub.layer,
        Layer.succeed(ClaudeProvider, provider("claude")),
        Layer.succeed(CodexProvider, provider("codex")),
        Layer.succeed(Events, { publish: (event) => Effect.sync(() => void pushes.push(event)) }),
      ),
    ),
    Layer.provideMerge(database),
    Layer.provide(NodeServices.layer),
  )
}

const savedAt = new Date("2026-10-12T03:00:00.000Z")
const issueAt = new Date("2026-10-12T03:00:01.000Z")

const addIssue = () => {
  linear.issues.push({
    id: "issue-32",
    identifier: "KAL-32",
    number: 32,
    title: "Just test issue",
    description: "Check Linear integration",
    url: "https://linear.app/kalan/issue/KAL-32/just-test-issue",
    createdAt: issueAt,
  })
}

afterEach(() => vi.useRealTimers())

describe("automation polling lifecycle", () => {
  for (const legacyCursor of [false, true]) {
    it.effect(
      `starts an issue created after saving and before the first poll${legacyCursor ? " with a legacy null cursor" : ""}`,
      () =>
        Effect.gen(function* () {
          vi.useFakeTimers({ toFake: ["Date"], now: savedAt })
          yield* TestClock.setTime(savedAt.getTime())
          linear.issues.length = 0
          linear.filters.length = 0
          const pushes: Array<PushEvent> = []
          const port = yield* unusedPort
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const { projectId } = yield* seedThread({ rootPath: "/repo" })
            yield* Secrets.Secrets.use((secrets) => secrets.set(LINEAR_API_KEY_SECRET, "test-api-key"))
            yield* McpCredentials.use((credentials) => credentials.listening("http://127.0.0.1:1/mcp"))
            const automations = yield* Automations
            const { automation } = yield* automations.create({
              projectId,
              name: "Linear issues",
              enabled: true,
              trigger: { type: "linear.issue", teamKey: "KAL" },
              promptTemplate: "Investigate {{issue.identifier}}: {{issue.title}}",
              provider: "claude",
              model: "test-model",
              runInWorktree: false,
              branchTemplate: null,
            })
            if (legacyCursor) yield* sql`UPDATE automation SET cursor = NULL WHERE id = ${automation.id}`
            addIssue()
            // A fixed random source gives the initial poll a five-second delay.
            vi.setSystemTime(new Date(savedAt.getTime() + 5_000))
            yield* TestClock.adjust("5 seconds")
            vi.setSystemTime(new Date(savedAt.getTime() + 65_000))
            yield* TestClock.adjust("60 seconds")

            const runs = yield* automations.runs(automation.id, 10)
            expect(runs).toHaveLength(1)
            expect(linear.filters[0]?.createdAt.gt.toISOString()).toBe(savedAt.toISOString())
            expect(runs[0]?.status).toBe("started")
            expect(runs[0]?.eventKey).toBe("linear:issue-32")
            expect(runs[0]?.error).toBeNull()
            const threadId = runs[0]?.threadId
            expect(threadId).toBeTypeOf("string")
            if (threadId === null || threadId === undefined) return yield* Effect.die("The run has no thread")
            const thread = yield* Threads.Threads.use((threads) => threads.get(threadId))
            expect(thread.createdBy).toBe(`automation:${automation.id}`)
            expect(thread.title).toBe("Investigate KAL-32: Just test issue")
            const transcript = yield* AgentRunner.AgentRunner.use((runner) => runner.transcript(threadId))
            expect(transcript.messages[0]?.parts).toStrictEqual([
              { type: "text", text: "Investigate KAL-32: Just test issue" },
            ])
            expect(pushes.some((event) => event.type === "automation.run" && event.run.id === runs[0]?.id)).toBe(true)
          }).pipe(Effect.provide(makeLayer(pushes, port)))
        }).pipe(Effect.provideService(Random.Random, { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => 0.5 })),
    )
  }
})
