import type { HinacodeBridge, RpcEnvelope, RpcMethod } from "../../src/shared/contract.ts"
import { methodKind } from "../../src/shared/contract.ts"
import type { Project, Thread } from "../../src/shared/domain.ts"
import { clouds } from "./fixtures.ts"
import {
  type App,
  baseOverrides,
  cloudBaseOverrides,
  decoyThreads,
  type Override,
  type Overrides,
  type PushEventEncoded,
  type Reply,
  scenarios,
} from "./scenarios.ts"
import { installWebviewShim } from "./webview.ts"

type Envelope = RpcEnvelope<unknown>

const MAIN_PROJECT = "hinacode"
const MAIN_THREAD = "Relay server e2e encryption"
const ASSETS = ["phone.png", "page.jpg"]
const AGO_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const CLOCK_SLACK_MS = 90_000

declare global {
  interface Window {
    __uiState: {
      readonly scenario: string
      readonly push: (event: PushEventEncoded) => void
      readonly hover: string | null
      ready: boolean
      error: string | null
    }
  }
}

const params = new URLSearchParams(location.search)
const scenario = scenarios.find((each) => each.name === params.get("scenario")) ?? scenarios[0]!
const theme = params.get("theme") ?? "hina-light"
const cloudIds = new Set(clouds.map((cloud) => cloud.id))

const forward = async (method: RpcMethod, payload: unknown, environment?: string): Promise<Envelope> => {
  const response = await fetch("/rpc", { method: "POST", body: JSON.stringify({ method, payload, environment }) })
  return (await response.json()) as Envelope
}

const resultOf = async <A>(method: RpcMethod): Promise<A> => {
  const envelope = await forward(method, undefined)
  if ("error" in envelope) throw new Error(`${method}: ${envelope.error.message}`)
  return envelope.result as A
}

const base64Of = async (file: string) => {
  const bytes = new Uint8Array(await (await fetch(`/assets/${file}`)).arrayBuffer())
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const [runtime, projects, threads, assets] = await Promise.all([
  fetch("/runtime").then((response) => response.json() as Promise<HinacodeBridge["runtime"]>),
  resultOf<ReadonlyArray<typeof Project.Encoded>>("projects.list"),
  resultOf<ReadonlyArray<typeof Thread.Encoded>>("threads.list"),
  Promise.all(ASSETS.map(async (file) => [file, await base64Of(file)] as const)).then((entries) => new Map(entries)),
])

const mainProject = projects.find((project) => project.name === MAIN_PROJECT)
const mainThread = threads.find((thread) => thread.title === MAIN_THREAD && thread.projectId === mainProject?.id)
if (!mainProject || !mainThread) {
  throw new Error(`the instance has no "${MAIN_THREAD}" thread in "${MAIN_PROJECT}"; launch it with scripts/break-ui`)
}

const resolveString = (value: string) => {
  const ago = /^@ago:(\d+)([mhd])$/.exec(value)
  if (ago) return new Date(Date.now() - CLOCK_SLACK_MS - Number(ago[1]) * AGO_UNITS[ago[2]!]!).toISOString()
  if (value.startsWith("asset:")) return assets.get(value.slice("asset:".length)) ?? value
  return value.replaceAll("$MAIN", mainThread.id).replaceAll("$ORIGIN", location.origin)
}

const resolveTokens = (value: unknown): unknown => {
  if (typeof value === "string") return resolveString(value)
  if (Array.isArray(value)) return value.map(resolveTokens)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [resolveString(key), resolveTokens(each)]))
  }
  return value
}

const visibleProjects = projects
  .filter((project) => project.id === mainProject.id || project.kind === "chats")
  .map((project) =>
    project.id === mainProject.id && scenario.remote ? { ...project, environmentId: scenario.remote } : project,
  )

const visibleThreads: ReadonlyArray<typeof Thread.Encoded> = [
  ...threads.filter((thread) => visibleProjects.some((project) => project.id === thread.projectId)),
  ...decoyThreads.map((decoy, index) => ({
    ...mainThread,
    id: `decoy-${index}`,
    title: decoy.title,
    status: decoy.status,
    pinnedAt: null,
    worktreeId: null,
    providerSessionId: null,
    queue: [],
    scheduled: [],
    sortIndex: mainThread.sortIndex + index + 1,
    updatedAt: resolveString(`@ago:${(index + 1) * 7}m`),
  })),
]

const builtIn: Partial<Record<RpcMethod, (real: Envelope) => Envelope>> = {
  "projects.list": () => ({ result: visibleProjects }),
  "threads.list": () => ({ result: visibleThreads }),
  "settings.get": (real) => {
    if ("error" in real) return real
    const settings = real.result as { experimental: object; pullRequestGuide: object }
    return {
      result: {
        ...settings,
        pullRequestGuide: { ...settings.pullRequestGuide, enabled: true },
        experimental: { ...settings.experimental, tinyVm: true, devices: true, ...scenario.experimental },
      },
    }
  },
  "clientSettings.get": (real) => {
    if ("error" in real) return real
    const settings = real.result as { appearance: object }
    return { result: { ...settings, locale: "en", appearance: { ...settings.appearance, theme } } }
  },
}

const replyFor = (override: Override<RpcMethod> | undefined, payload: unknown): Reply<RpcMethod> | undefined => {
  if (override === undefined || override === "pending" || !("by" in override)) return override
  const key = (payload as Record<string, unknown> | undefined)?.[override.by]
  return Object.entries(override.replies).find(([candidate]) => resolveString(candidate) === key)?.[1]
}

const layers = (environment: string | undefined): ReadonlyArray<Overrides | undefined> =>
  environment === undefined
    ? [scenario.overrides, baseOverrides]
    : [scenario.cloudOverrides, cloudBaseOverrides, scenario.overrides, baseOverrides]

const rpc = async (method: RpcMethod, payload: unknown, environment?: string): Promise<Envelope> => {
  for (const overrides of layers(environment)) {
    const reply = replyFor(overrides?.[method] as Override<RpcMethod> | undefined, payload)
    if (reply === "pending") return new Promise(() => undefined)
    if (reply !== undefined) return resolveTokens(structuredClone(reply)) as Envelope
  }
  const patch = builtIn[method]
  if (patch) return patch(await forward(method, payload))
  if (methodKind[method] !== "read") return { result: undefined }
  return forward(method, payload, environment !== undefined && cloudIds.has(environment) ? undefined : environment)
}

const listeners = new Set<(event: PushEventEncoded) => void>()
const push = (event: PushEventEncoded) => {
  for (const listener of listeners) listener(resolveTokens(event) as PushEventEncoded)
}
new EventSource("/events").addEventListener("message", (message: MessageEvent<string>) =>
  push(JSON.parse(message.data) as PushEventEncoded),
)

const bridge: HinacodeBridge = {
  rpc: rpc as HinacodeBridge["rpc"],
  onEvent: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  pathForFile: () => "",
  liquidGlass: false,
  runtime,
}
Object.defineProperty(window, "hinacode", { value: bridge })
window.__uiState = { scenario: scenario.name, push, hover: scenario.hover ?? null, ready: false, error: null }

localStorage.clear()
localStorage.setItem("hinacode.location", resolveString(scenario.path ?? "/thread/$MAIN"))
if (scenario.entry && !params.has("entry")) {
  params.set("entry", resolveString(scenario.entry))
  history.replaceState(null, "", `?${params}`)
}

installWebviewShim()
await import("@/main.tsx")

const [{ useUi }, { useBrowserTabs, selectBrowserTabs }, { useDeviceTabs }] = await Promise.all([
  import("@/stores/ui.ts"),
  import("@/stores/browserTabs.ts"),
  import("@/stores/deviceTabs.ts"),
])

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

const waitFor = async (selector: string) => {
  for (let tries = 0; tries < 200; tries++) {
    const found = document.querySelector(selector)
    if (found) return found
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${selector}`)
}

const thread = mainThread.id
const app: App = {
  thread,
  showView: (view) => useUi.getState().showView(thread, view),
  openBrowser: (url) => {
    const { activeId } = selectBrowserTabs(thread)(useBrowserTabs.getState())
    useBrowserTabs.getState().updateTab(thread, activeId, { url: url === null ? null : resolveString(url) })
  },
  selectDeviceTab: (tab) => useDeviceTabs.getState().select(thread, tab),
  floatVm: () => useUi.getState().setVmPlacement(thread, "floating"),
  openResources: () => useUi.getState().setResourcesOpen(true),
  pickPullRequest: (url) => useUi.getState().pickPullRequest(thread, url),
  push,
  waitFor,
  type: async (selector, text) => {
    const input = (await waitFor(selector)) as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  },
  sleep,
}

try {
  await waitFor("#root > *")
  await scenario.setup?.(app)
  for (const event of scenario.events ?? []) push(event)
  await sleep(300)
  window.__uiState.ready = true
} catch (cause) {
  window.__uiState.error = String(cause)
}
