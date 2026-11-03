import { expect, type Page } from "@playwright/test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Given, Then, When, type WebStack } from "../support/fixtures.ts"
import { sidebar } from "../support/ui.ts"

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

const signIn = async (page: Page, web: WebStack, ownerToken: string) => {
  const relayField = page.getByRole("textbox", { name: "Relay", exact: true })
  if (!(await relayField.isVisible()))
    await page.getByRole("button", { name: "Use another relay", exact: true }).click()
  await relayField.fill(web.relay.url)
  await page.getByRole("textbox", { name: "Owner token", exact: true }).fill(ownerToken)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
}

const openMachineResources = async (page: Page) => {
  await page.getByRole("button", { name: "Machine resources", exact: true }).click()
  return page.getByRole("dialog")
}

const expectMachineListed = async (page: Page, web: WebStack) => {
  await expect(sidebar(page)).toBeVisible()
  const resources = await openMachineResources(page)
  await expect(resources.getByText(web.machine.name, { exact: true })).toBeVisible()
  await expect(resources.getByText("This machine", { exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
}

Given("I open the web app", async ({ page, web }) => {
  await page.goto(web.appUrl)
})

When("I sign in to the relay with the owner token {string}", async ({ page, web }, ownerToken: string) => {
  await signIn(page, web, ownerToken)
})

When("I sign in to the relay with my owner token", async ({ page, web }) => {
  await signIn(page, web, web.relay.ownerToken)
})

Then("the sign-in form says {string}", async ({ page }, message: string) => {
  await expect(page.getByRole("alert")).toHaveText(message)
})

Then("the app lists my machine as a remote machine", async ({ page, web }) => {
  await expectMachineListed(page, web)
})

Given("I signed in to the web app", async ({ page, web }) => {
  await page.goto(web.appUrl)
  await signIn(page, web, web.relay.ownerToken)
  await expect(sidebar(page)).toBeVisible()
})

When("I reload the web app", async ({ page }) => {
  await page.reload()
})

Then("the app lists my machine without asking to sign in", async ({ page, web }) => {
  await expectMachineListed(page, web)
  await expect(page.getByRole("textbox", { name: "Owner token", exact: true })).toHaveCount(0)
})

When("I open the Add project dialog on the web", async ({ page }) => {
  await page.getByRole("button", { name: "Add project", exact: true }).first().click()
})

Then('the dialog adds to my machine, with no Browse button and no "This machine"', async ({ page, web }) => {
  const dialog = page.getByRole("dialog", { name: "Add project", exact: true })
  await expect(dialog.getByLabel("Folder or GitHub repository", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Browse…", exact: true })).toHaveCount(0)
  const where = dialog.getByRole("combobox", { name: "Where", exact: true })
  await expect(where).toHaveText(web.machine.name)
  await where.click()
  await expect(page.getByRole("option", { name: "This machine", exact: true })).toHaveCount(0)
  await page.getByRole("option", { name: web.machine.name, exact: true }).click()
})

When(
  "I add the project {string} by typing the path of the machine's repository",
  async ({ page, names, webRepo }, project: string) => {
    const dialog = page.getByRole("dialog", { name: "Add project", exact: true })
    await dialog.getByLabel("Folder or GitHub repository", { exact: true }).fill(webRepo)
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(names.of(project))
    await dialog.getByRole("button", { name: "Add project", exact: true }).click()
    await expect(dialog).toBeHidden()
  },
)

When("I start a new thread in {string} on the web", async ({ page, names, web }, project: string) => {
  await page.getByRole("button", { name: `New thread in ${names.of(project)}`, exact: true }).click()
  await expect(
    page.getByRole("heading", {
      name: `What do you want to work on ${names.of(project)} in ${web.machine.name}?`,
      exact: true,
    }),
  ).toBeVisible()
})

When("I send {string} from the web", async ({ page }, message: string) => {
  await page.getByRole("combobox", { name: "Message", exact: true }).fill(message)
  await page.getByRole("button", { name: "Send", exact: true }).click()
})

Then("the agent's Markdown reply streams into the web thread", async ({ page }) => {
  const reply = page.locator("article[aria-busy]")
  await expect(reply.getByRole("heading", { level: 1, name: "Heading 1 with code" })).toBeVisible()
  await expect(reply).toHaveAttribute("aria-busy", "false")
  await expect(reply.getByRole("heading", { level: 2, name: "Links", exact: true })).toBeVisible()
})

Given(
  "the machine has a project {string} whose repository holds the image {string}",
  ({ names, web, webRepo }, project: string, image: string) => {
    writeFileSync(join(webRepo, image), Buffer.from(ONE_PIXEL_PNG, "base64"))
    web.machine.seed.project({ name: names.of(project), rootPath: webRepo })
  },
)

When("I open {string} from the Files tab on the web", async ({ page }, file: string) => {
  const details = page.getByRole("complementary", { name: "Thread details" })
  await details.getByRole("tab", { name: "Files", exact: true }).click()
  await page.getByRole("tree", { name: "Workspace files" }).getByRole("treeitem", { name: file, exact: true }).click()
})

Then("the image {string} loads in the file viewer", async ({ page }, file: string) => {
  const image = page.getByRole("img", { name: file, exact: true })
  await expect(image).toHaveJSProperty("naturalWidth", 1)
  expect(new URL(await image.evaluate((node: HTMLImageElement) => node.currentSrc)).pathname).toMatch(/^\/_r\//)
})

When("the machine stops", async ({ web }) => {
  await web.machine.stop()
})

Then("Machine resources shows my machine offline", async ({ page }) => {
  const resources = await openMachineResources(page)
  await expect(resources.getByText(/^(Offline|Connecting)/)).toBeVisible({ timeout: 25_000 })
  await page.keyboard.press("Escape")
})

When("the machine starts again", async ({ web }) => {
  await web.machine.start()
})

Then("Machine resources shows my machine back online", async ({ page }) => {
  const resources = await openMachineResources(page)
  await expect(resources.getByText(/^(Offline|Connecting)/)).toHaveCount(0, { timeout: 25_000 })
  await page.keyboard.press("Escape")
})
