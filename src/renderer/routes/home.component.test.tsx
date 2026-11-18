import { RegistryProvider } from "@effect/atom-react"
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Schema } from "effect"
import { Suspense } from "react"
import { beforeEach, expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { AgentAccount, ProviderId } from "../../shared/agent.ts"
import { type HinacodeBridge, RpcMethods } from "../../shared/contract.ts"
import { defaultClientSettings, defaultSettings, type Project, type Thread } from "../../shared/domain.ts"
import "../index.css"
import { useThreads } from "../stores/threads.ts"
import { HomeRoute } from "./home.tsx"

const signedOut: AgentAccount = { type: "signedOut" }
const team: AgentAccount = { type: "subscription", email: "dev@example.com", plan: "Claude Team", organization: null }

let accounts: Partial<Record<ProviderId, AgentAccount>> = {}
let projects: Array<Project> = []
let accountCalls: Array<{ provider: string; refresh: boolean }> = []

const project = (id: string, kind: Project["kind"]): Project => ({
  id,
  name: id,
  rootPath: `/tmp/${id}`,
  setupScript: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  linearReview: false,
  kind,
  actions: [],
})

const thread: Thread = {
  id: "t-1",
  projectId: "chats",
  worktreeId: null,
  title: "First",
  provider: "claude",
  model: "claude-sonnet-5-5",
  effort: null,
  fastMode: false,
  accessMode: "full",
  accountId: null,
  providerSessionId: null,
  forkedFrom: null,
  sideOf: null,
  parentId: null,
  status: "idle",
  usageLimit: null,
  slack: null,
  sortIndex: 0,
  pinnedAt: null,
  settledAt: null,
  snoozedUntil: null,
  queue: [],
  scheduled: [],
  createdBy: "user",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
}

const installed = (provider: ProviderId) => provider === "claude" || provider === "codex"

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "clientSettings.get")
      return { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
    if (method === "settings.get") return { result: defaultSettings }
    if (method === "projects.list") return { result: projects }
    if (method === "agents.binaries")
      return {
        result: Object.fromEntries(
          (["claude", "codex", "muse", "opencode", "magpie"] as const).map((provider) => [
            provider,
            { installed: installed(provider), path: installed(provider) ? `/usr/bin/${provider}` : null },
          ]),
        ),
      }
    if (method === "agents.account") {
      const { provider, refresh } = payload as { provider: ProviderId; refresh?: boolean }
      accountCalls.push({ provider, refresh: refresh === true })
      return { result: accounts[provider] ?? signedOut }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

beforeEach(async () => {
  await page.viewport(1280, 900)
  accounts = { claude: signedOut, codex: signedOut }
  projects = [project("chats", "chats")]
  accountCalls = []
  useThreads.getState().replaceAll([])
})

const openHome = async () => {
  const rootRoute = createRootRoute()
  const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomeRoute })
  const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  return render(
    <RegistryProvider>
      <Suspense>
        <RouterProvider router={router} />
      </Suspense>
    </RegistryProvider>,
  )
}

const agents = () => page.getByRole("list", { name: "Agents on this computer" })
const step = (name: string) => page.getByRole("heading", { level: 3, name })
const addProject = () => page.getByRole("button", { name: /^Add project/ })
const newThread = () => page.getByRole("button", { name: /^New thread/ })

test("a fresh install starts on signing in, with each installed agent's login command", async () => {
  await openHome()

  await expect.element(page.getByRole("heading", { name: "Get started" })).toBeVisible()
  await expect.element(agents().getByText("Not signed in. Run claude in a terminal, then /login.")).toBeVisible()
  await expect.element(agents().getByText("Not signed in. Run codex login in a terminal.")).toBeVisible()
  await expect.element(agents().getByText("Muse Code")).not.toBeInTheDocument()
  await expect.element(step("Sign in to an agent")).toBeVisible()
  await expect.element(addProject()).not.toHaveClass("bg-primary")
  await expect.element(newThread()).not.toHaveClass("bg-primary")
  expect(new Set(accountCalls.map((call) => call.provider))).toEqual(new Set(["claude", "codex"]))
})

test("signing in from a terminal ticks the agent step when the window gets focus back", async () => {
  await openHome()
  await expect.element(agents().getByText("Run claude in a terminal", { exact: false })).toBeVisible()

  accounts.claude = team
  window.dispatchEvent(new FocusEvent("focus"))

  await expect.element(step("Sign in to an agent (done)")).toBeVisible()
  await expect.element(agents().getByText("Claude Team")).toBeVisible()
  await expect.element(agents().getByText("dev@example.com")).not.toBeInTheDocument()
  await expect.element(addProject()).toHaveClass("bg-primary")
  expect(accountCalls).toContainEqual({ provider: "claude", refresh: true })
})

test("Check again asks only the signed-out agents", async () => {
  accounts.codex = team
  await openHome()
  await expect.element(step("Sign in to an agent (done)")).toBeVisible()

  await page.getByRole("button", { name: "Check again" }).click()

  await expect.poll(() => accountCalls).toContainEqual({ provider: "claude", refresh: true })
  expect(accountCalls).not.toContainEqual({ provider: "codex", refresh: true })
})

test("a folder project ticks the project step and moves the primary button to New thread", async () => {
  accounts.claude = team
  projects = [project("chats", "chats"), project("repo", "folder")]
  await openHome()

  await expect.element(step("Add a project (done)")).toBeVisible()
  await expect.element(newThread()).toHaveClass("bg-primary")
  await expect.element(addProject()).not.toHaveClass("bg-primary")
})

test("once a thread exists the home screen drops the checklist", async () => {
  useThreads.getState().replaceAll([thread])
  await openHome()

  await expect.element(newThread()).toBeVisible()
  await expect.element(page.getByRole("heading", { name: "Get started" })).not.toBeInTheDocument()
  expect(accountCalls).toEqual([])
})
