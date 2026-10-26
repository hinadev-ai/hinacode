import { dirname, join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import type { ClaudeProvider } from "./agents/claude/index.ts"
import type { CodexProvider } from "./agents/codex/index.ts"
import type { MuseProvider } from "./agents/muse/index.ts"
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
import * as AgentRunner from "./services/AgentRunner.ts"
import * as Attachments from "./services/Attachments.ts"
import * as Browser from "./services/Browser.ts"
import { Automations } from "./services/automations/Automations.ts"
import * as ClientSettings from "./services/ClientSettings.ts"
import * as Environments from "./services/Environments.ts"
import { type Events, makeEventsLayer, type PushBroadcast, type WindowPush } from "./services/Events.ts"
import * as Favicons from "./services/Favicons.ts"
import * as Files from "./services/Files.ts"
import * as Git from "./services/Git.ts"
import * as GitHub from "./services/GitHub.ts"
import * as Linear from "./services/Linear.ts"
import * as Messages from "./services/Messages.ts"
import * as Ports from "./services/Ports.ts"
import * as SystemResources from "./services/SystemResources.ts"
import * as Projects from "./services/Projects.ts"
import * as PullRequestGuides from "./services/PullRequestGuides.ts"
import * as RelayAccount from "./services/RelayAccount.ts"
import * as Search from "./services/Search.ts"
import * as Secrets from "./services/Secrets.ts"
import * as Settings from "./services/Settings.ts"
import * as Terminals from "./services/Terminals.ts"
import * as Threads from "./services/Threads.ts"
import { ThreadNaming } from "./services/ThreadNaming.ts"
import * as PasskeyRelay from "./services/tinyVm/passkey/PasskeyRelay.ts"
import * as TinyVm from "./services/tinyVm/TinyVm.ts"
import { unsupported, Updates } from "./services/Updates.ts"
import * as Worktrees from "./services/Worktrees.ts"

const automationsStub = Layer.succeed(Automations, {} as typeof Automations.Service)
const updatesStub = Layer.succeed(Updates, unsupported("0.0.0"))

export interface TestAppOptions {
  readonly providers: Layer.Layer<ClaudeProvider | CodexProvider | MuseProvider>
  /** Defaults to the Electron-backed layer, which sends to the mocked `BrowserWindow`s. */
  readonly events?: Layer.Layer<Events | PushBroadcast | WindowPush>
}

/**
 * The app layer of `index.ts` with scripted agents, no automations, no updater and no pull request guides, over a
 * SQLite file at `dbPath`.
 * Tests that keep the default `events` must mock `electron` first.
 */
export const makeTestAppLayer = (
  dbPath: string,
  { providers, events = makeEventsLayer(sendToWindows) }: TestAppOptions,
) => {
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provideMerge(Terminals.layer),
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(AgentAccounts.layer),
      Layer.provideMerge(Settings.layer),
    ),
    ClientSettings.layer,
    Messages.layer,
    Attachments.layer(join(dirname(dbPath), "attachments")),
    Search.layer,
    Files.layer,
  )
  const remoteAccess = RemoteAccess.layer.pipe(Layer.provide(Secrets.layer))
  const relay = Relay.layer().pipe(Layer.provide(Layer.mergeAll(remoteAccess, Secrets.layer)))
  const tinyVm = TinyVm.layer(
    { configPath: join(dirname(dbPath), "sbx", "config.json"), env: {} },
    join(dirname(dbPath), "tiny-vm"),
  )
  const passkeys = PasskeyRelay.layer(join(dirname(dbPath), "tiny-vm")).pipe(Layer.provide(tinyVm))
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
    passkeys,
    linear,
    peers,
  ).pipe(Layer.provide(domain))
  const agents = AgentRunner.layer.pipe(
    Layer.provide(Layer.mergeAll(providers, Layer.succeed(ThreadNaming, { nameFromPrompt: () => Effect.void }))),
    Layer.provideMerge(Layer.mergeAll(domain, features)),
  )
  const logins = AgentLogins.layer.pipe(Layer.provide(Layer.mergeAll(providers, agents)))
  const environments = RelayAccount.layer({ serviceUrl: Relay.DEFAULT_RELAY_SERVICE_URL }).pipe(
    Layer.provide(Layer.mergeAll(Secrets.layer, agents)),
  )
  const base = Layer.mergeAll(agents, automationsStub, updatesStub, logins, environments, PullRequestGuides.idleLayer)
  const app = Layer.mergeAll(base, Mcp.serverLayer.pipe(Layer.provide(base)))
  return Layer.mergeAll(RemoteServer.layer, answerAsksLayer).pipe(
    Layer.provideMerge(app),
    Layer.provideMerge(events),
    Layer.provideMerge(Layer.mergeAll(Git.layer, GitHub.layer, Favicons.layer)),
    Layer.provideMerge(Db.layer(dbPath)),
    Layer.provide(Layer.mergeAll(NodeServices.layer, Secrets.noKeyring)),
  )
}
