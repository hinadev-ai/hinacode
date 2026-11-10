import { dirname, join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import type { ClaudeProvider } from "./agents/claude/index.ts"
import type { CodexProvider } from "./agents/codex/index.ts"
import type { MuseProvider } from "./agents/muse/index.ts"
import type { MagpieProvider } from "./agents/magpie/index.ts"
import type { OpencodeProvider } from "./agents/opencode/index.ts"
import * as Db from "./db/client.ts"
import { sendToWindows } from "./ipc.ts"
import { answerAsksLayer } from "./environments/route.ts"
import * as Mcp from "./mcp/index.ts"
import * as RemoteAccess from "./remote/access.ts"
import * as Peers from "./remote/peers.ts"
import * as Relay from "./remote/relay.ts"
import * as RemoteServer from "./remote/server.ts"
import * as AgentAccounts from "./services/AgentAccounts.ts"
import * as AgentLogins from "./services/AgentLogins.ts"
import * as SessionImports from "./services/SessionImports.ts"
import * as AgentRunner from "./services/AgentRunner.ts"
import * as ArtifactFeedback from "./services/ArtifactFeedback.ts"
import * as ArtifactInspector from "./services/ArtifactInspector.ts"
import * as Artifacts from "./services/Artifacts.ts"
import * as Attachments from "./services/Attachments.ts"
import * as Browser from "./services/Browser.ts"
import { Routines } from "./services/routines/Routines.ts"
import * as ClientSettings from "./services/ClientSettings.ts"
import * as Environments from "./services/Environments.ts"
import { type Events, makeEventsLayer, type PushBroadcast, type WindowPush } from "./services/Events.ts"
import * as Favicons from "./services/Favicons.ts"
import * as Files from "./services/Files.ts"
import * as Git from "./services/Git.ts"
import * as GitHub from "./services/GitHub.ts"
import * as SourceControl from "./services/SourceControl.ts"
import * as Linear from "./services/Linear.ts"
import * as Messages from "./services/Messages.ts"
import * as Ports from "./services/Ports.ts"
import * as SystemResources from "./services/SystemResources.ts"
import * as Projects from "./services/Projects.ts"
import * as PullRequestGuides from "./services/PullRequestGuides.ts"
import * as RelayAccount from "./services/RelayAccount.ts"
import * as Scratch from "./services/Scratch.ts"
import * as Search from "./services/Search.ts"
import * as Secrets from "./services/Secrets.ts"
import * as Settings from "./services/Settings.ts"
import * as Settle from "./services/Settle.ts"
import * as Terminals from "./services/Terminals.ts"
import * as Threads from "./services/Threads.ts"
import { ThreadNaming } from "./services/ThreadNaming.ts"
import * as TinyVm from "./services/tinyVm/TinyVm.ts"
import { unavailableDevicesLayer } from "./services/devices/unavailable.ts"
import { unsupported, Updates } from "./services/Updates.ts"
import * as Worktrees from "./services/Worktrees.ts"

const routinesStub = Layer.succeed(Routines, {} as typeof Routines.Service)
const updatesStub = Layer.succeed(Updates, unsupported("0.0.0"))

export interface TestAppOptions {
  readonly providers: Layer.Layer<ClaudeProvider | CodexProvider | MuseProvider | OpencodeProvider | MagpieProvider>
  readonly events?: Layer.Layer<Events | PushBroadcast | WindowPush>
}

export const makeTestAppLayer = (
  dbPath: string,
  { providers, events = makeEventsLayer(sendToWindows) }: TestAppOptions,
) => {
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provideMerge(Scratch.layer(join(dirname(dbPath), "scratch"), { tmpRoot: join(dirname(dbPath), "tmp") })),
      Layer.provideMerge(Terminals.layer),
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(AgentAccounts.layer),
      Layer.provideMerge(Settings.layer(dirname(dbPath))),
    ),
    ClientSettings.layer(dirname(dbPath)),
    Messages.layer,
    Attachments.layer(join(dirname(dbPath), "attachments")),
    Artifacts.layer(join(dirname(dbPath), "artifacts")),
    ArtifactInspector.unavailable,
    Search.layer,
    Files.layer,
  )
  const remoteAccess = RemoteAccess.layer.pipe(Layer.provide(Secrets.layer))
  const relay = Relay.layer().pipe(Layer.provide(Layer.mergeAll(remoteAccess, Secrets.layer)))
  const tinyVm = TinyVm.layer(
    { configPath: join(dirname(dbPath), "sbx", "config.json"), env: {} },
    join(dirname(dbPath), "tiny-vm"),
  )
  const linear = Linear.layer.pipe(Layer.provide(Secrets.layer))
  const peers = Peers.layer.pipe(
    Layer.provideMerge(Environments.layer),
    Layer.provide(Layer.mergeAll(remoteAccess, Secrets.layer)),
  )
  const features = Layer.mergeAll(
    Mcp.credentialsLayer,
    Ports.layer,
    Browser.layer,
    SystemResources.layer,
    remoteAccess,
    relay,
    tinyVm,
    linear,
    peers,
    unavailableDevicesLayer,
  ).pipe(Layer.provide(domain))
  const agents = AgentRunner.layer.pipe(
    Layer.provide(providers),
    Layer.provideMerge(
      Layer.succeed(ThreadNaming, { nameFromPrompt: () => Effect.void, regenerateTitle: () => Effect.die("unused") }),
    ),
    Layer.provideMerge(Layer.mergeAll(domain, features)),
  )
  const logins = AgentLogins.layer(join(dirname(dbPath), "cache")).pipe(
    Layer.provide(Layer.mergeAll(providers, agents)),
  )
  const imports = SessionImports.layer.pipe(Layer.provide(Layer.mergeAll(providers, agents)))
  const environments = RelayAccount.layer({ serviceUrl: Relay.DEFAULT_RELAY_SERVICE_URL }).pipe(
    Layer.provide(Layer.mergeAll(Secrets.layer, agents)),
  )
  const base = Layer.mergeAll(
    agents,
    routinesStub,
    updatesStub,
    logins,
    imports,
    environments,
    PullRequestGuides.idleLayer,
    Settle.layer.pipe(Layer.provide(agents)),
    ArtifactFeedback.layer.pipe(Layer.provide(agents)),
  )
  const app = Layer.mergeAll(base, Mcp.serverLayer.pipe(Layer.provide(base)))
  return Layer.mergeAll(RemoteServer.layer, answerAsksLayer).pipe(
    Layer.provideMerge(app),
    Layer.provideMerge(SourceControl.layer),
    Layer.provideMerge(Layer.mergeAll(Git.layer, GitHub.layer, Favicons.layer)),
    Layer.provideMerge(events),
    Layer.provideMerge(Db.layer(dbPath)),
    Layer.provide(Layer.mergeAll(NodeServices.layer, Secrets.noKeyring)),
  )
}
