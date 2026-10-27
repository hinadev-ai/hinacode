import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import * as ClaudeProvider from "./agents/claude/index.ts"
import { mockScenarios, usageLimitLayer } from "./agents/claude/mock.ts"
import { CodexProvider } from "./agents/codex/index.ts"
import { MuseProvider } from "./agents/muse/index.ts"
import * as Db from "./db/client.ts"
import { answerAsksLayer } from "./environments/route.ts"
import * as Mcp from "./mcp/index.ts"
import * as RemoteAccess from "./remote/access.ts"
import * as Peers from "./remote/peers.ts"
import * as Relay from "./remote/relay.ts"
import * as RemoteServer from "./remote/server.ts"
import { applyServeConfig, type ServeConfig } from "./serve.ts"
import type { PushEvent } from "../shared/contract.ts"
import * as AgentAccounts from "./services/AgentAccounts.ts"
import * as AgentLogins from "./services/AgentLogins.ts"
import * as AgentRunner from "./services/AgentRunner.ts"
import * as Attachments from "./services/Attachments.ts"
import * as AutoArchive from "./services/AutoArchive.ts"
import * as Browser from "./services/Browser.ts"
import * as Automations from "./services/automations/Automations.ts"
import * as ClientSettings from "./services/ClientSettings.ts"
import * as Environments from "./services/Environments.ts"
import { type Events, makeEventsLayer } from "./services/Events.ts"
import * as Favicons from "./services/Favicons.ts"
import * as Files from "./services/Files.ts"
import * as Git from "./services/Git.ts"
import * as GitHub from "./services/GitHub.ts"
import * as Linear from "./services/Linear.ts"
import * as Messages from "./services/Messages.ts"
import * as Ports from "./services/Ports.ts"
import * as Projects from "./services/Projects.ts"
import * as PullRequestGuides from "./services/PullRequestGuides.ts"
import * as PullRequestWatcher from "./services/PullRequestWatcher.ts"
import * as RelayAccount from "./services/RelayAccount.ts"
import * as Search from "./services/Search.ts"
import * as Secrets from "./services/Secrets.ts"
import * as Settings from "./services/Settings.ts"
import * as SystemResources from "./services/SystemResources.ts"
import * as Terminals from "./services/Terminals.ts"
import * as ThreadNaming from "./services/ThreadNaming.ts"
import * as Threads from "./services/Threads.ts"
import * as PasskeyRelay from "./services/tinyVm/passkey/PasskeyRelay.ts"
import * as TinyVm from "./services/tinyVm/TinyVm.ts"
import type { Updates } from "./services/Updates.ts"
import * as Worktrees from "./services/Worktrees.ts"

/** Where the app keeps its database, attachments and VM state, and what differs between the desktop and a cloud. */
export interface AppOptions {
  readonly userData: string
  /** Where `sbx login` keeps its login. */
  readonly sbxConfigPath: string
  readonly keyring: Layer.Layer<Secrets.Keyring>
  readonly updates: Layer.Layer<Updates, never, Events | Threads.Threads | Worktrees.Worktrees | Terminals.Terminals>
  /** Sends a push to the desktop windows. A cloud has none. */
  readonly toWindows: (event: typeof PushEvent.Encoded) => void
  /** Set for `hinacode serve`: forces the remote listener on at this address. */
  readonly serve?: ServeConfig
}

/** Scripted Claude turns for e2e and manual testing, chosen by `HINACODE_MOCK_CLAUDE`. */
const simulatedClaude = (env: NodeJS.ProcessEnv) => {
  const mode = env["HINACODE_MOCK_CLAUDE"]
  if (mode === undefined) return undefined
  const scenario = mockScenarios.find((candidate) => candidate === mode)
  if (scenario === undefined) throw new Error(`HINACODE_MOCK_CLAUDE must be one of ${mockScenarios.join(", ")}`)
  if (!env["HINACODE_USER_DATA"]) throw new Error("Claude simulation requires HINACODE_USER_DATA")
  const resetMs = Number(env["HINACODE_MOCK_RESET_MS"] ?? 60000)
  if (!Number.isFinite(resetMs) || Math.abs(resetMs) > 3600000)
    throw new Error("HINACODE_MOCK_RESET_MS must be between -3600000 and 3600000")
  return usageLimitLayer(scenario, resetMs)
}

/** Demo Linear tickets for screenshots and manual testing, chosen by `HINACODE_MOCK_LINEAR=1`. */
const linearLayer = (env: NodeJS.ProcessEnv) => {
  if (env["HINACODE_MOCK_LINEAR"] === undefined) return Linear.layer.pipe(Layer.provide(Secrets.layer))
  if (!env["HINACODE_USER_DATA"]) throw new Error("Linear simulation requires HINACODE_USER_DATA")
  return Linear.mockLayer
}

/** Every main-process service, for the desktop app (`index.ts`) and for `hinacode serve` (`daemon.ts`). */
export const makeAppLayer = ({ userData, sbxConfigPath, keyring, updates, toWindows, serve }: AppOptions) => {
  const mockClaude = simulatedClaude(process.env)
  const chats = Layer.effectDiscard(Projects.Projects.use((projects) => projects.ensureChats(join(userData, "chats"))))
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provideMerge(chats),
      Layer.provideMerge(Terminals.layer),
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(AgentAccounts.layer),
      Layer.provideMerge(Settings.layer),
    ),
    ClientSettings.layer,
    Messages.layer,
    Attachments.layer(join(userData, "attachments")),
    Search.layer,
    Files.layer,
  )
  const naming =
    mockClaude === undefined
      ? ThreadNaming.layer
      : Layer.succeed(ThreadNaming.ThreadNaming, { nameFromPrompt: () => Effect.void })
  const claude = mockClaude ?? ClaudeProvider.layer
  const remoteAccess = RemoteAccess.layer.pipe(Layer.provide(Secrets.layer))
  const relayServiceUrl = process.env["HINACODE_RELAY_URL"] ?? Relay.DEFAULT_RELAY_SERVICE_URL
  const relay = Relay.layer({ serviceUrl: relayServiceUrl, cloudflaredDir: join(userData, "cloudflared") }).pipe(
    Layer.provide(Layer.mergeAll(remoteAccess, Secrets.layer)),
  )
  const tinyVm = TinyVm.layer({ configPath: sbxConfigPath, env: process.env }, join(userData, "tiny-vm"))
  const passkeys = PasskeyRelay.layer(join(userData, "tiny-vm")).pipe(Layer.provide(tinyVm))
  const peers = Peers.layer.pipe(
    Layer.provideMerge(Environments.layer),
    Layer.provide(Layer.mergeAll(remoteAccess, Secrets.layer)),
  )
  const features = Layer.mergeAll(
    Mcp.credentialsLayer,
    Ports.layer,
    Browser.layer,
    SystemResources.layer,
    naming,
    remoteAccess,
    relay,
    tinyVm,
    passkeys,
    peers,
    linearLayer(process.env),
  ).pipe(Layer.provide(domain))
  const agents = AgentRunner.layer.pipe(Layer.provideMerge(Layer.mergeAll(domain, features)))
  // The MCP server's tools start turns and ask for secrets, so it sits above the runner.
  const services = Layer.mergeAll(
    Automations.layer,
    AutoArchive.layer,
    PullRequestWatcher.layer,
    mockClaude === undefined ? PullRequestGuides.layer : PullRequestGuides.idleLayer,
    updates,
    Mcp.serverLayer,
    AgentLogins.layer,
    RelayAccount.layer({ serviceUrl: relayServiceUrl }).pipe(Layer.provide(Secrets.layer)),
  ).pipe(Layer.provideMerge(agents))
  // The remote listener dispatches every rpc method, so it sits above everything the handlers use.
  // A cloud's address is written below it, so the listener's first read of its settings already has it.
  return Layer.mergeAll(RemoteServer.layer, answerAsksLayer).pipe(
    Layer.provideMerge(Layer.effectDiscard(serve ? applyServeConfig(serve) : Effect.void)),
    Layer.provideMerge(services),
    Layer.provide(Layer.mergeAll(claude, CodexProvider.layer, MuseProvider.layer)),
    Layer.provideMerge(makeEventsLayer(toWindows)),
    Layer.provideMerge(Layer.mergeAll(Git.layer, GitHub.layer, Favicons.layer)),
    Layer.provide(Layer.mergeAll(Db.layer(join(userData, "hinacode.sqlite")), keyring)),
    Layer.provide(NodeServices.layer),
  )
}
