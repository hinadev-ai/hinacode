import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router"
import { beforeEach, expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../shared/contract.ts"
import type { Project } from "../../shared/domain.ts"
import "../index.css"
import { useThreads } from "../stores/threads.ts"
import { DeleteProjectDialog } from "./DeleteProjectDialog.tsx"

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "projects.list") return { result: [] } as never
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const project: Project = {
  id: "project-1",
  name: "demo",
  rootPath: "/code/demo",
  setupScript: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  linearReview: false,
  kind: "folder",
  actions: [],
}

beforeEach(() => {
  useThreads.setState({ byId: {} } as never)
})

const renderDialog = async () => {
  const rootRoute = createRootRoute({
    component: () => (
      <DeleteProjectDialog project={project} open onOpenChange={() => {}} focusAfterDelete={{ current: null }} />
    ),
  })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })
  await router.load()
  return render(<RouterProvider router={router} />)
}

const description = () => page.getByRole("alertdialog").getByText(/folder on disk stays/)

test("a project without threads does not count its threads", async () => {
  await renderDialog()
  await expect.element(description()).toHaveTextContent("The folder on disk stays. This cannot be undone.")
})

test("a project with threads says they are deleted", async () => {
  useThreads.setState({ byId: { "thread-1": { id: "thread-1", projectId: project.id } } } as never)
  await renderDialog()
  await expect
    .element(description())
    .toHaveTextContent(
      "Its 1 thread, with its messages and linked pull requests, is deleted. The folder on disk stays. This cannot be undone.",
    )
})
