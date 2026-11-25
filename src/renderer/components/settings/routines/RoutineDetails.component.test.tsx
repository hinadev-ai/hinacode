import { RegistryProvider } from "@effect/atom-react"
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { beforeEach, expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../../shared/contract.ts"
import { defaultSettings, type Routine } from "../../../../shared/domain.ts"
import "../../../index.css"
import { RoutineDetails } from "./RoutineDetails.tsx"

const routine: Routine = {
  id: "routine-1",
  projectId: "project-1",
  name: "Answer Linear",
  enabled: true,
  prompt: "Answer the comment",
  provider: "claude",
  model: "",
  effort: null,
  workspace: "local",
  schedule: null,
  trigger: {
    event: "linear.comment",
    fromUsers: ["ada@example.com"],
    scopes: [],
    contains: null,
    continuation: "conversation",
  },
  nextRunAt: null,
  lastRun: null,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
}

const stored = new Set<string>()
const answeredSecrets: Array<string> = []
let bothSecretsAnswered = Promise.withResolvers<void>()

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "settings.get") return { result: defaultSettings }
    if (method === "routines.runs") return { result: [] }
    if (method === "secrets.has") {
      const { name } = payload as { name: string }
      answeredSecrets.push(name)
      if (answeredSecrets.length === 2) bothSecretsAnswered.resolve()
      return { result: stored.has(name) }
    }
    if (method === "routines.webhook") {
      await bothSecretsAnswered.promise
      return {
        result: {
          url: "http://127.0.0.1:7420/hooks/routine-1",
          githubUrl: "http://127.0.0.1:7420/hooks/github",
          linearUrl: "http://127.0.0.1:7420/hooks/linear",
          hasSecret: true,
          listenError: null,
        },
      }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

beforeEach(() => {
  stored.clear()
  answeredSecrets.length = 0
  bothSecretsAnswered = Promise.withResolvers<void>()
})

const renderDetails = async () => {
  const rootRoute = createRootRoute({
    component: () => <RoutineDetails routine={routine} environment={null} machine="This Mac" />,
  })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await render(
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>,
  )
}

const warning = () => page.getByText(/Linear needs an API key and a webhook signing secret/)

test("a Linear trigger warns when the webhook signing secret is not stored", async () => {
  stored.add("linear.apiKey")
  await renderDetails()

  await expect.element(warning()).toBeVisible()
  await expect.element(page.getByRole("link", { name: "Add them in Integrations" })).toBeVisible()
})

test("a Linear trigger shows its webhook address and no warning once both secrets are stored", async () => {
  stored.add("linear.apiKey")
  stored.add("linear.webhookSecret")
  await renderDetails()

  await expect.element(page.getByText("http://127.0.0.1:7420/hooks/linear")).toBeVisible()
  await expect.element(page.getByRole("button", { name: "Copy Linear webhook URL" })).toBeVisible()
  expect(answeredSecrets.toSorted()).toEqual(["linear.apiKey", "linear.webhookSecret"])
  await expect.element(warning()).not.toBeInTheDocument()
})
