import type { PushEvent, RpcFailure, RpcMethod, RpcResponseEncoded } from "../../src/shared/contract.ts"
import type { ExperimentalSettings } from "../../src/shared/domain.ts"
import {
  attachedDevice,
  clouds,
  deviceFrame,
  devicesHost,
  GITHUB_AUTH,
  MAIN_PULL_REQUEST,
  pullRequestGuide,
  pullRequestLinks,
  pullRequestOverrides,
  pullRequests,
  remoteBrowserState,
  remoteFrame,
  resources,
  runningVm,
  vmHost,
} from "./fixtures.ts"

export type Reply<M extends RpcMethod> =
  | { readonly result: RpcResponseEncoded<M> }
  | { readonly error: RpcFailure }
  | "pending"

export interface Keyed<M extends RpcMethod> {
  readonly by: string
  readonly replies: Readonly<Record<string, Reply<M>>>
}

export type Override<M extends RpcMethod> = Reply<M> | Keyed<M>

export type Overrides = { readonly [M in RpcMethod]?: Override<M> }

export type PushEventEncoded = typeof PushEvent.Encoded

export interface App {
  readonly thread: string
  readonly showView: (view: "browser" | "devices" | "tinyVm" | "pullRequests") => void
  readonly openBrowser: (url: string | null) => void
  readonly selectDeviceTab: (tab: string) => void
  readonly floatVm: () => void
  readonly openResources: () => void
  readonly pickPullRequest: (url: string) => void
  readonly push: (event: PushEventEncoded) => void
  readonly waitFor: (selector: string) => Promise<Element>
  readonly type: (selector: string, text: string) => Promise<void>
  readonly sleep: (ms: number) => Promise<void>
}

export interface Scenario {
  readonly name: string
  readonly path?: string
  readonly entry?: string
  readonly remote?: string
  readonly hover?: string
  readonly experimental?: Partial<ExperimentalSettings>
  readonly overrides?: Overrides
  readonly cloudOverrides?: Overrides
  readonly events?: ReadonlyArray<PushEventEncoded>
  readonly setup?: (app: App) => Promise<void> | void
}

const SETTINGS_CONNECTIONS = "/settings?page=connections"
const SHOP_PAGE = "$ORIGIN/assets/shop.html"
const UNRESOLVED_PAGE = "http://staging.fernwood.invalid/checkout"

const world: Overrides = {
  "environments.list": { result: { clouds } },
  "agents.updates": { result: [] },
  "updates.status": { result: { current: "0.43.0", state: { type: "upToDate" } } },
  "system.resources": { result: resources(0.18, 0.52) },
  "github.auth": { result: GITHUB_AUTH },
  "pullRequests.all": { result: pullRequestLinks },
  "pullRequests.list": { by: "threadId", replies: { $MAIN: { result: pullRequestLinks } } },
  ...pullRequestOverrides,
}

const connectedClouds: Overrides = {
  "updates.status": { result: { current: "0.42.0", state: { type: "ready", version: "0.43.0" } } },
  "system.resources": { result: resources(0.61, 0.74) },
}

const remoteScenarios: ReadonlyArray<Scenario> = [
  { name: "remote-connections", path: SETTINGS_CONNECTIONS },
  { name: "remote-resources", setup: (app) => app.openResources() },
  { name: "remote-thread-offline", remote: "cloud-studio" },
  { name: "remote-thread-connecting", remote: "cloud-gpu" },
  { name: "remote-thread-unauthorized", remote: "cloud-ci" },
  { name: "remote-thread-incompatible", remote: "cloud-old" },
]

const showDevices = (app: App) => app.showView("devices")

const preparing = (step: "creating" | "slimming" | "booting" | "connecting") =>
  ({
    phase: "preparing",
    deviceId: attachedDevice.id,
    name: attachedDevice.name,
    owned: true,
    step,
  }) as const

const deviceScenarios: ReadonlyArray<Scenario> = [
  {
    name: "devices-list-ready",
    overrides: { "devices.list": { result: devicesHost.ready }, "device.get": { result: [] } },
    setup: showDevices,
  },
  {
    name: "devices-list-missing-xcode",
    overrides: { "devices.list": { result: devicesHost.missingXcode }, "device.get": { result: [] } },
    setup: showDevices,
  },
  {
    name: "devices-list-unsupported",
    overrides: { "devices.list": { result: devicesHost.unsupported }, "device.get": { result: [] } },
    setup: showDevices,
  },
  {
    name: "devices-list-loading",
    overrides: { "devices.list": "pending", "device.get": { result: [] } },
    setup: showDevices,
  },
  ...(["creating", "slimming", "booting", "connecting"] as const).map((step, index, steps): Scenario => ({
    name: `devices-preparing-${step}`,
    overrides: { "devices.list": { result: devicesHost.ready }, "device.get": { result: [preparing(steps[0]!)] } },
    setup: async (app) => {
      showDevices(app)
      await app.waitFor("ol[aria-label]")
      for (const next of steps.slice(1, index + 1)) {
        app.push({ type: "device.updated", threadId: app.thread, devices: [preparing(next)] })
        await app.sleep(50)
      }
    },
  })),
  {
    name: "devices-ready-agent",
    overrides: {
      "devices.list": { result: devicesHost.ready },
      "device.get": {
        result: [
          {
            phase: "ready",
            device: attachedDevice,
            screen: { width: 390, height: 844, scale: 3 },
            control: "agent",
            agentWaiting: null,
          },
        ],
      },
      "device.frame": { result: { frame: deviceFrame } },
    },
    setup: showDevices,
  },
  {
    name: "devices-ready-user-waiting",
    overrides: {
      "devices.list": { result: devicesHost.ready },
      "device.get": {
        result: [
          {
            phase: "ready",
            device: attachedDevice,
            screen: { width: 390, height: 844, scale: 3 },
            control: "user",
            agentWaiting: { kind: "tap", x: 0.5, y: 0.9 },
          },
        ],
      },
      "device.frame": { result: { frame: deviceFrame } },
    },
    setup: showDevices,
  },
  {
    name: "devices-failed",
    overrides: {
      "devices.list": { result: devicesHost.ready },
      "device.get": {
        result: [
          {
            phase: "failed",
            deviceId: attachedDevice.id,
            name: attachedDevice.name,
            owned: true,
            message: "simctl boot failed: Unable to boot the Simulator. launchd failed to respond. (code 164)",
          },
        ],
      },
    },
    setup: showDevices,
  },
]

const openBrowserAt =
  (url: string | null) =>
  (app: App): void => {
    app.openBrowser(url)
    app.showView("browser")
  }

const browserScenarios: ReadonlyArray<Scenario> = [
  { name: "browser-local-start", setup: openBrowserAt(null) },
  { name: "browser-local-page", setup: openBrowserAt(SHOP_PAGE) },
  { name: "browser-local-failure", setup: openBrowserAt(UNRESOLVED_PAGE) },
  { name: "browser-remote-idle", remote: "cloud-build", setup: openBrowserAt(null) },
  {
    name: "browser-remote-opening",
    remote: "cloud-build",
    overrides: { "browser.open": "pending" },
    setup: openBrowserAt(SHOP_PAGE),
  },
  ...(
    [
      ["loading", { loading: true }, true],
      ["page", {}, true],
      ["failure", { url: UNRESOLVED_PAGE, title: "", failure: "net::ERR_NAME_NOT_RESOLVED" }, false],
      ["pick", { pick: { kind: "selecting" } }, true],
    ] as const
  ).map(([state, patch, withFrame]): Scenario => ({
    name: `browser-remote-${state}`,
    remote: "cloud-build",
    overrides: {
      "browser.open": { result: { sessionId: "browser-session-1" } },
      "browser.frame": {
        result: { state: remoteBrowserState(patch), frame: withFrame ? remoteFrame : null },
      },
    },
    setup: openBrowserAt(SHOP_PAGE),
  })),
]

const showVm = (app: App) => app.showView("tinyVm")

const vmScenarios: ReadonlyArray<Scenario> = [
  ...(["connected", "notConfigured", "unreachable"] as const).map((host): Scenario => ({
    name: `vm-none-${host === "notConfigured" ? "not-configured" : host}`,
    overrides: { "vm.get": { result: { status: "none" } }, "vm.host": { result: vmHost[host] } },
    setup: showVm,
  })),
  {
    name: "vm-starting",
    overrides: { "vm.get": { result: { status: "starting" } }, "vm.host": { result: vmHost.connected } },
    setup: showVm,
  },
  {
    name: "vm-running-agent",
    overrides: {
      "vm.get": { result: runningVm.agent },
      "vm.desktop.url": { result: { url: "$ORIGIN/assets/vm-desktop.html" } },
    },
    setup: showVm,
  },
  {
    name: "vm-running-user-waiting",
    overrides: {
      "vm.get": { result: runningVm.userWaiting },
      "vm.control": { result: runningVm.userWaiting },
      "vm.desktop.url": { result: { url: "$ORIGIN/assets/vm-desktop.html" } },
    },
    setup: showVm,
  },
  {
    name: "vm-running-sbx-connecting",
    experimental: { tinyVmProvider: "sbx" },
    overrides: { "vm.get": { result: { ...runningVm.agent, provider: "sbx" } } },
    setup: showVm,
  },
  {
    name: "vm-running-sbx-user",
    experimental: { tinyVmProvider: "sbx" },
    overrides: {
      "vm.get": { result: { ...runningVm.userWaiting, provider: "sbx" } },
      "vm.screen.open": "pending",
    },
    setup: showVm,
  },
  {
    name: "vm-failed",
    overrides: {
      "vm.get": {
        result: {
          status: "failed",
          message: 'Sandbox create failed: template "desktop-large" needs 8 GB, the host has 6.1 GB free.',
        },
      },
      "vm.host": { result: vmHost.connected },
    },
    setup: showVm,
  },
  {
    name: "vm-floating",
    overrides: {
      "vm.get": { result: runningVm.agent },
      "vm.desktop.url": { result: { url: "$ORIGIN/assets/vm-desktop.html" } },
    },
    setup: (app) => {
      showVm(app)
      app.floatVm()
    },
  },
]

const showPullRequest = (url: string) => (app: App) => {
  app.pickPullRequest(url)
  app.showView("pullRequests")
}

const windowEntry = `/thread/$MAIN/pull-request?url=${encodeURIComponent(MAIN_PULL_REQUEST)}`

const pullRequestScenarios: ReadonlyArray<Scenario> = [
  ...Object.entries(pullRequests).map(([state, pullRequest]): Scenario => ({
    name: `pr-panel-${state}`,
    setup: showPullRequest(pullRequest.url),
  })),
  { name: "pr-sidebar-stack", hover: "button[aria-label$='linked pull requests']" },
  { name: "pr-window-loaded", entry: windowEntry },
  { name: "pr-window-loading", entry: windowEntry, overrides: { "github.pullRequestDetail": "pending" } },
  {
    name: "pr-window-failed",
    entry: windowEntry,
    overrides: {
      "github.pullRequestDetail": {
        error: { tag: "GitHubError", message: "GitHub answered 502 Bad Gateway for hinadev-ai/hinacode#1204" },
      },
    },
  },
  { name: "pr-window-diff-loading", entry: windowEntry, overrides: { "github.pullRequestFiles": "pending" } },
  {
    name: "pr-window-diff-failed",
    entry: windowEntry,
    overrides: {
      "github.pullRequestFiles": {
        error: { tag: "GitHubError", message: "The diff is too large to load (more than 3,000 files)." },
      },
    },
  },
  {
    name: "pr-window-filter-empty",
    entry: windowEntry,
    setup: (app) => app.type("aside input", "payments"),
  },
  {
    name: "pr-window-guide-running",
    entry: windowEntry,
    overrides: {
      "pullRequestGuides.get": { result: { guide: null, job: { status: "running", head: pullRequestGuide.head } } },
    },
  },
]

export const baseOverrides = world
export const cloudBaseOverrides = connectedClouds

export const scenarios: ReadonlyArray<Scenario> = [
  ...remoteScenarios,
  ...deviceScenarios,
  ...browserScenarios,
  ...vmScenarios,
  ...pullRequestScenarios,
]

export const decoyThreads: ReadonlyArray<{ readonly title: string; readonly status: "idle" | "running" }> = [
  { title: "Retry the relay handshake with backoff", status: "running" },
  { title: "Pin the relay certificate per machine", status: "idle" },
  { title: "Show relay latency in the machines popover", status: "idle" },
  { title: "Fix the flaky worktree setup test", status: "idle" },
]
