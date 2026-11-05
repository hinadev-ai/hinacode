import { writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  addProject,
  openFile,
  openMachineResources,
  openSignedIn,
  sendMessage,
  sidebar,
  signIn,
  startThread,
} from "./support/app.ts"
import { expect, test } from "./support/fixtures.ts"

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

test("signing in loads the app with the relay's machines", async ({ page, web }) => {
  await page.goto(web.appUrl)
  await signIn(page, web, "not-the-token")
  await expect(page.getByRole("alert")).toHaveText(
    "The relay refused this token. Copy the current one from the desktop.",
  )
  await signIn(page, web)
  const resources = await openMachineResources(page)
  await expect(resources.getByText(web.machine.name, { exact: true })).toBeVisible()
})

test("reloading goes straight back to the app", async ({ page, web }) => {
  await openSignedIn(page, web)
  await page.reload()
  await expect(sidebar(page)).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Owner token", exact: true })).toHaveCount(0)
})

test("a project added by path talks to the agent on the machine", async ({ page, web, repo, uniqueName }) => {
  const project = uniqueName("web")
  await openSignedIn(page, web)
  await addProject(page, repo, project)
  await startThread(page, web, project)
  await sendMessage(page, "Show me some Markdown")
  const reply = page.locator("article[aria-busy]")
  await expect(reply.getByRole("heading", { level: 1, name: "Heading 1 with code" })).toBeVisible()
  await expect(reply).toHaveAttribute("aria-busy", "false")
})

test("an image in the project previews through the service worker", async ({ page, web, repo, uniqueName }) => {
  const project = uniqueName("pics")
  writeFileSync(join(repo, "pixel.png"), Buffer.from(ONE_PIXEL_PNG, "base64"))
  await openSignedIn(page, web)
  await addProject(page, repo, project)
  await startThread(page, web, project)
  const served = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/_r/"))
  await openFile(page, "pixel.png")
  const image = page.getByRole("img", { name: "pixel.png", exact: true })
  await expect(image).toHaveJSProperty("naturalWidth", 1)
  expect((await served).headers()["content-security-policy"]).toBe("sandbox allow-scripts")
})

test("the app shows when the machine drops and comes back", async ({ page, web }) => {
  await openSignedIn(page, web)
  await web.machine.stop()
  let resources = await openMachineResources(page)
  await expect(resources.getByText(/^(Offline|Connecting)/)).toBeVisible({ timeout: 25_000 })
  await page.keyboard.press("Escape")
  await web.machine.start()
  resources = await openMachineResources(page)
  await expect(resources.getByText(/^(Offline|Connecting)/)).toHaveCount(0, { timeout: 25_000 })
})
