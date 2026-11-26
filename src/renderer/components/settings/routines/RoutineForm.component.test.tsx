import { RegistryProvider } from "@effect/atom-react"
import { beforeEach, expect, test } from "vitest"
import { cdp, page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { ModelInfo } from "../../../../shared/agent.ts"
import { Schema } from "effect"
import { type HinacodeBridge, RpcMethods } from "../../../../shared/contract.ts"
import { defaultClientSettings, defaultSettings, type Project, type Routine } from "../../../../shared/domain.ts"
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

const routine: Routine = {
  id: "routine-1",
  projectId: project.id,
  name: "Answer comments",
  enabled: true,
  prompt: "Answer the comment",
  provider: "claude",
  model: "",
  effort: null,
  workspace: "local",
  schedule: null,
  trigger: {
    event: "github.pull_request_comment",
    fromUsers: ["octocat", "hubot"],
    scopes: ["acme/api"],
    contains: "@hina",
    continuation: "new",
  },
  nextRunAt: null,
  lastRun: null,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
}

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

beforeEach(() => {
  created.length = 0
})

const renderCreate = () =>
  render(
    <RegistryProvider>
      <RoutineDialog state={{ mode: "create" }} projects={[project]} onClose={() => {}} />
    </RegistryProvider>,
  )

const fillNameAndPrompt = async () => {
  await page.getByRole("textbox", { name: "Name" }).fill("Answer comments")
  await page.getByRole("combobox", { name: "Prompt" }).click()
  await cdp().send("Input.insertText", { text: "Answer the comment" })
}

const pickTrigger = async (event: string) => {
  await page.getByRole("combobox", { name: "Trigger" }).click()
  await page.getByRole("option", { name: event }).click()
}

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

test("saves no trigger when None is picked", async () => {
  renderCreate()
  await fillNameAndPrompt()
  await expect.element(page.getByRole("combobox", { name: "Trigger" })).toHaveTextContent("None")

  await page.getByRole("button", { name: "Create routine" }).click()
  await expect.poll(() => created).toHaveLength(1)
  expect(created[0]).toMatchObject({ trigger: null })
})

test("saves the GitHub trigger filled in the form", async () => {
  renderCreate()
  await fillNameAndPrompt()
  await pickTrigger("GitHub issue comment")
  await page.getByRole("textbox", { name: "From" }).fill("@octocat, hubot")
  await page.getByRole("textbox", { name: "Repositories" }).fill("acme/api")

  await page.getByRole("button", { name: "Create routine" }).click()
  await expect.poll(() => created).toHaveLength(1)
  expect(created[0]).toMatchObject({
    trigger: {
      event: "github.issue_comment",
      fromUsers: ["octocat", "hubot"],
      scopes: ["acme/api"],
      contains: null,
      continuation: "conversation",
    },
  })
})

test("cannot save an event trigger without a sender", async () => {
  renderCreate()
  await fillNameAndPrompt()
  const submit = page.getByRole("button", { name: "Create routine" })
  await expect.element(submit).toBeEnabled()

  await pickTrigger("GitHub issue opened")
  await expect.element(submit).toBeDisabled()
  await page.getByRole("textbox", { name: "From" }).fill("octocat")
  await expect.element(submit).toBeEnabled()
})

test("editing a routine shows its trigger", async () => {
  render(
    <RegistryProvider>
      <RoutineDialog state={{ mode: "edit", routine }} projects={[project]} onClose={() => {}} />
    </RegistryProvider>,
  )
  await expect.element(page.getByRole("combobox", { name: "Trigger" })).toHaveTextContent("GitHub pull request comment")
  await expect.element(page.getByRole("textbox", { name: "From" })).toHaveValue("octocat, hubot")
  await expect.element(page.getByRole("textbox", { name: "Repositories" })).toHaveValue("acme/api")
  await expect.element(page.getByRole("textbox", { name: "Contains" })).toHaveValue("@hina")
  await expect.element(page.getByRole("switch", { name: "Continue the same thread" })).not.toBeChecked()
})
