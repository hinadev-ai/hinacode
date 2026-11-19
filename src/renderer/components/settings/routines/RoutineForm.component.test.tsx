import { RegistryProvider } from "@effect/atom-react"
import { expect, test } from "vitest"
import { cdp, page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { ModelInfo } from "../../../../shared/agent.ts"
import { Schema } from "effect"
import { type HinacodeBridge, RpcMethods } from "../../../../shared/contract.ts"
import { defaultClientSettings, defaultSettings, type Project } from "../../../../shared/domain.ts"
import "../../../index.css"
import { RoutineDialog } from "./RoutineForm.tsx"

const project: Project = {
  id: "project-1",
  name: "demo",
  rootPath: "/tmp/demo",
  setupScript: null,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
  linearReview: false,
  kind: "folder",
  actions: [],
}

const models: ReadonlyArray<ModelInfo> = [
  {
    id: "listed-model",
    label: "Listed model",
    provider: "claude",
    efforts: [],
    defaultEffort: null,
    fastMode: false,
    autoMode: false,
  },
]

const created: Array<unknown> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "settings.get") return { result: defaultSettings }
    if (method === "clientSettings.get")
      return { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
    if (method === "agents.binaries")
      return {
        result: {
          claude: { installed: true, path: "/usr/bin/claude" },
          codex: { installed: false, path: null },
          muse: { installed: false, path: null },
          opencode: { installed: false, path: null },
          magpie: { installed: false, path: null },
        },
      }
    if (method === "models.list") return { result: models }
    if (method === "commands.forProject") return { result: [] }
    if (method === "routines.list") return { result: [] }
    if (method === "routines.create") {
      created.push(payload)
      return { error: { tag: "NotStubbed", message: method } }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

test("creates a routine on the agent default model once name, schedule and prompt are filled", async () => {
  render(
    <RegistryProvider>
      <RoutineDialog state={{ mode: "create" }} projects={[project]} onClose={() => {}} />
    </RegistryProvider>,
  )
  await page.getByRole("textbox", { name: "Name" }).fill("Nightly sweep")
  await page.getByRole("combobox", { name: "Prompt" }).click()
  await cdp().send("Input.insertText", { text: "Sweep the inbox" })

  const submit = page.getByRole("button", { name: "Create routine" })
  await expect.element(submit).toBeEnabled()
  await submit.click()
  await expect.poll(() => created).toHaveLength(1)
  expect(created[0]).toMatchObject({ provider: "claude", model: "" })
})
