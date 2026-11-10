import { join } from "node:path"
import { ProviderId } from "../shared/agent.ts"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { AgentBinaries } from "./agents/binary.ts"
import * as ClaudeProvider from "./agents/claude/index.ts"
import { mockScenarios, usageLimitLayer } from "./agents/claude/mock.ts"
import { CodexProvider } from "./agents/codex/index.ts"
import { MuseProvider } from "./agents/muse/index.ts"
import { MagpieProvider } from "./agents/magpie/index.ts"
import { OpencodeProvider } from "./agents/opencode/index.ts"
import * as AppConnections from "./apps/AppConnections.ts"
import * as AppServer from "./apps/server.ts"
import * as Db from "./db/client.ts"
import { answerAsksLayer } from "./environments/route.ts"
import * as Mcp from "./mcp/index.ts"
import * as RemoteAccess from "./remote/access.ts"
import * as CliSocket from "./remote/cliSocket.ts"
import * as Peers from "./remote/peers.ts"
import * as Relay from "./remote/relay.ts"
import * as RemoteServer from "./remote/server.ts"
import { applyServeConfig, type ServeConfig } from "./serve.ts"
import type { PushEvent } from "../shared/contract.ts"
import * as AgentAccounts from "./services/AgentAccounts.ts"
import * as AgentLogins from "./services/AgentLogins.ts"
import * as SessionImports from "./services/SessionImports.ts"
import * as AgentRunner from "./services/AgentRunner.ts"
import * as ArtifactFeedback from "./services/ArtifactFeedback.ts"
import * as ArtifactInspector from "./services/ArtifactInspector.ts"
import * as Artifacts from "./services/Artifacts.ts"
import * as Attachments from "./services/Attachments.ts"
import * as Boat from "./services/boat/Boat.ts"
import * as Settle from "./services/Settle.ts"
import * as Browser from "./services/Browser.ts"
import * as Routines from "./services/routines/Routines.ts"
import * as Scheduler from "./services/Scheduler.ts"
import * as ClientSettings from "./services/ClientSettings.ts"
import * as Conductor from "./services/Conductor.ts"
import * as Environments from "./services/Environments.ts"
import * as EventBus from "./services/EventBus.ts"
import { type Events, makeEventsLayer } from "./services/Events.ts"
import * as Favicons from "./services/Favicons.ts"
import * as Files from "./services/Files.ts"
import * as Git from "./services/Git.ts"
import * as GitHub from "./services/GitHub.ts"
import * as SourceControl from "./services/SourceControl.ts"
import * as Linear from "./services/Linear.ts"
import * as Messages from "./services/Messages.ts"
import * as Ports from "./services/Ports.ts"
import * as Projects from "./services/Projects.ts"
import * as PullRequestGuides from "./services/PullRequestGuides.ts"
import * as PullRequestLifecycle from "./services/PullRequestLifecycle.ts"
import * as PullRequestWatcher from "./services/PullRequestWatcher.ts"
import * as RelayAccount from "./services/RelayAccount.ts"
import * as Scratch from "./services/Scratch.ts"
import * as Search from "./services/Search.ts"
import * as Secrets from "./services/Secrets.ts"
import * as Settings from "./services/Settings.ts"
import * as SystemResources from "./services/SystemResources.ts"
import * as Terminals from "./services/Terminals.ts"
import * as ThreadNaming from "./services/ThreadNaming.ts"
import * as Threads from "./services/Threads.ts"
import * as TinyVm from "./services/tinyVm/TinyVm.ts"
import type { Updates } from "./services/Updates.ts"
import * as Worktrees from "./services/Worktrees.ts"
import { makeAndroidDriver } from "./services/devices/android.ts"
import { devicesLayer } from "./services/devices/Devices.ts"
import { makeIosDriver, simslimAvailable } from "./services/devices/ios.ts"
import { simhelperSources } from "./services/devices/simhelperSources.ts"
import { SpanLedger, traceLayer } from "./trace.ts"
import { STALL_MS, watchdogLayer } from "./watchdog.ts"

export interface AppOptions {
  readonly userData: string
  readonly sbxConfigPath: string
  readonly keyring: Layer.Layer<Secrets.Keyring>
  readonly updates: Layer.Layer<Updates, never, Events | Threads.Threads | Worktrees.Worktrees | Terminals.Terminals>
  readonly toWindows: (event: typeof PushEvent.Encoded) => void
  readonly serve?: ServeConfig
  readonly artifactInspector?: Layer.Layer<ArtifactInspector.ArtifactInspector>
}

const simulatedClaude = (variable: "HINACODE_MOCK_AGENTS" | "HINACODE_MOCK_CLAUDE", env: NodeJS.ProcessEnv) => {
  const mode = env[variable]
  if (mode === undefined) return undefined
  const scenario = mockScenarios.find((candidate) => candidate === mode)
  if (scenario === undefined) throw new Error(`${variable} must be one of ${mockScenarios.join(", ")}`)
  if (!env["HINACODE_USER_DATA"]) throw new Error("Claude simulation requires HINACODE_USER_DATA")
  const resetMs = Number(env["HINACODE_MOCK_RESET_MS"] ?? 60000)
  if (!Number.isFinite(resetMs) || Math.abs(resetMs) > 3600000)
    throw new Error("HINACODE_MOCK_RESET_MS must be between -3600000 and 3600000")
  return usageLimitLayer(scenario, resetMs)
}

export const agentProviders = (env: NodeJS.ProcessEnv) => {
  const everyAgent = simulatedClaude("HINACODE_MOCK_AGENTS", env)
  if (everyAgent !== undefined)
    return {
      simulated: true,
      simulatedProviders: new Set(ProviderId.literals),
      layer: Layer.mergeAll(
        Layer.effect(
          CodexProvider,
          ClaudeProvider.ClaudeProvider.useSync((claude) => ({ ...claude, id: "codex" })),
        ),
        Layer.effect(
          MuseProvider,
          ClaudeProvider.ClaudeProvider.useSync((claude) => ({ ...claude, id: "muse" })),
        ),
        Layer.effect(
          OpencodeProvider,
          ClaudeProvider.ClaudeProvider.useSync((claude) => ({ ...claude, id: "opencode" })),
        ),
        Layer.effect(
          MagpieProvider,
          ClaudeProvider.ClaudeProvider.useSync((claude) => ({ ...claude, id: "magpie" })),
        ),
      ).pipe(Layer.provideMerge(everyAgent)),
    }
  const claude = simulatedClaude("HINACODE_MOCK_CLAUDE", env)
  return {
    simulated: claude !== undefined,
    simulatedProviders: new Set<ProviderId>(claude === undefined ? [] : ["claude"]),
    layer: Layer.mergeAll(
      claude ?? ClaudeProvider.layer,
      CodexProvider.layer,
      MuseProvider.layer,
      OpencodeProvider.layer,
      MagpieProvider.layer,
    ),
  }
}

const linearLayer = (env: NodeJS.ProcessEnv) => {
  if (env["HINACODE_MOCK_LINEAR"] === undefined) return Linear.layer.pipe(Layer.provide(Secrets.layer))
  if (!env["HINACODE_USER_DATA"]) throw new Error("Linear simulation requires HINACODE_USER_DATA")
  return Linear.mockLayer
}

export const makeAppLayer = ({
  userData,
  sbxConfigPath,
  keyring,
  updates,
  toWindows,
  serve,
  artifactInspector = ArtifactInspector.unavailable,
}: AppOptions) => {
  const providers = agentProviders(process.env)
  const settings = Settings.layer(userData)
  const binaries = Layer.effect(
    AgentBinaries,
    Effect.gen(function* () {
      const store = yield* Settings.Settings
      return {
        configured: store.get.pipe(
          Effect.map((current) => current.providerBinary),
          Effect.orElseSucceed(() => ({})),
        ),
        simulated: providers.simulatedProviders,
      }
    }),
  ).pipe(Layer.provide(settings))
  const spans = new SpanLedger(STALL_MS)
  const chats = Layer.effectDiscard(Projects.Projects.use((projects) => projects.ensureChats(join(userData, "chats"))))
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provideMerge(chats),
      Layer.provideMerge(Scratch.layer(join(userData, "scratch"))),
      Layer.provideMerge(Terminals.layer),
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(AgentAccounts.layer),
      Layer.provideMerge(settings),
    ),
    ClientSettings.layer(userData),
    Messages.layer,
    Attachments.layer(join(userData, "attachments")),
    Artifacts.layer(join(userData, "artifacts")),
    artifactInspector,
    Search.layer,
    Files.layer,
  )
  const naming = providers.simulated
    ? Layer.effect(
        ThreadNaming.ThreadNaming,
        Effect.map(Threads.Threads, (threads) => ({
          nameFromPrompt: () => Effect.void,
          regenerateTitle: (threadId: string) => threads.get(threadId),
        })),
      )
    : ThreadNaming.layer
  const remoteAccess = RemoteAccess.layer.pipe(Layer.provide(Secrets.layer))
  const relayServiceUrl = process.env["HINACODE_RELAY_URL"] ?? Relay.DEFAULT_RELAY_SERVICE_URL
  const relay = Relay.layer({ serviceUrl: relayServiceUrl, cloudflaredDir: join(userData, "cloudflared") }).pipe(
    Layer.provide(Layer.mergeAll(remoteAccess, Secrets.layer)),
  )
  const boat = Boat.layer(process.env).pipe(Layer.provide(Secrets.layer))
  const tinyVm = TinyVm.layer({ configPath: sbxConfigPath, env: process.env }, join(userData, "tiny-vm"), {
    desktopRedirect: serve === undefined,
  }).pipe(Layer.provide(boat))
  const peers = Peers.layer.pipe(
    Layer.provideMerge(Environments.layer),
    Layer.provide(Layer.mergeAll(remoteAccess, Secrets.layer)),
  )
  const devices = devicesLayer({
    drivers: {
      ios: makeIosDriver({ cacheDir: join(userData, "devices"), sources: simhelperSources }),
      android: makeAndroidDriver(),
    },
    simslimAvailable: () => simslimAvailable(),
  })
  const features = Layer.mergeAll(
    Mcp.credentialsLayer,
    Ports.layer,
    Browser.layer,
    SystemResources.layer,
    naming,
    remoteAccess,
    relay,
    AppConnections.layer.pipe(Layer.provide(remoteAccess)),
    tinyVm,
    peers,
    devices,
    linearLayer(process.env),
  ).pipe(Layer.provide(domain))
  const agents = AgentRunner.layer.pipe(Layer.provideMerge(Layer.mergeAll(domain, features)))
  const services = Layer.mergeAll(
    Routines.layer.pipe(Layer.provide(Scheduler.layer)),
    Settle.layer,
    ArtifactFeedback.layer,
    PullRequestWatcher.layer,
    PullRequestLifecycle.layer,
    providers.simulated ? PullRequestGuides.idleLayer : PullRequestGuides.layer,
    updates,
    Mcp.serverLayer,
    AgentLogins.layer(join(userData, "cache")),
    SessionImports.layer,
    RelayAccount.layer({ serviceUrl: relayServiceUrl }).pipe(Layer.provide(Secrets.layer)),
    AppConnections.followRelayLayer,
    AppServer.layer.pipe(Layer.provide(Secrets.layer)),
  ).pipe(Layer.provideMerge(agents))
  return Layer.mergeAll(RemoteServer.layer, CliSocket.layer(userData), answerAsksLayer, Conductor.layer).pipe(
    Layer.provideMerge(Layer.effectDiscard(serve ? applyServeConfig(serve) : Effect.void)),
    Layer.provideMerge(services),
    Layer.provide(providers.layer.pipe(Layer.provide(Layer.mergeAll(settings, Secrets.layer, binaries)))),
    Layer.provideMerge(binaries),
    Layer.provideMerge(SourceControl.layer),
    Layer.provideMerge(Layer.mergeAll(Git.layer, GitHub.layer, Favicons.layer, EventBus.layer)),
    Layer.provideMerge(makeEventsLayer(toWindows)),
    Layer.provide(Layer.mergeAll(Db.layer(join(userData, "hinacode.sqlite")), keyring)),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(watchdogLayer(spans)),
    Layer.provideMerge(traceLayer(process.env["HINACODE_TRACE"], spans)),
  )
}
