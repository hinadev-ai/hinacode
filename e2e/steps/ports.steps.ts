import { expect } from "@playwright/test"
import { tmpdir } from "node:os"
import { Then, When } from "../support/fixtures.ts"
import { isAlive, listenFrom } from "../support/listener.ts"
import { threadDetails } from "../support/ui.ts"

const portsRegion = async (page: import("@playwright/test").Page) =>
  (await threadDetails(page)).getByRole("region", { name: "Ports" })

When("a server starts listening from my repository", async ({ repo, listeners }) => {
  listeners.set("repository", await listenFrom(repo))
})

When("a server starts listening outside my repository", async ({ listeners }) => {
  listeners.set("outside", await listenFrom(tmpdir()))
})

const portRow = async (page: import("@playwright/test").Page, port: number) =>
  (await portsRegion(page)).getByRole("listitem").filter({ hasText: `:${port}` })

// The button arms on the first click and only stops the process on the second.
When("I stop the server from my repository in the ports panel", async ({ app, listeners }) => {
  const { port } = listeners.get("repository")!
  const row = await portRow(app.page, port)
  await row.getByRole("button", { name: new RegExp(`^Stop .* on port ${port}$`) }).click()
  await row.getByRole("button", { name: /^Click again to stop / }).click()
})

// The process shows under its kernel name, which depends on the Node build (`node` or `node-MainThread`).
Then("the ports panel lists the server from my repository", async ({ app, listeners }) => {
  const { port, pid } = listeners.get("repository")!
  await expect(await portRow(app.page, port)).toContainText(`(pid ${pid})`)
})

Then("the ports panel does not list the server from outside my repository", async ({ app, listeners }) => {
  const { port } = listeners.get("outside")!
  const ports = await portsRegion(app.page)
  await expect(ports.getByRole("listitem").filter({ hasText: `:${port}` })).toHaveCount(0)
})

Then("the ports panel is empty", async ({ app }) => {
  await expect((await portsRegion(app.page)).getByText("No open ports")).toBeVisible()
})

Then("the server from my repository has exited", async ({ listeners }) => {
  const { pid } = listeners.get("repository")!
  await expect.poll(() => isAlive(pid)).toBe(false)
})
