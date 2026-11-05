import { expect, type Page } from "@playwright/test"
import type { WebStack } from "./fixtures.ts"

export const sidebar = (page: Page) => page.getByRole("navigation", { name: "Projects and threads" })

export const signIn = async (page: Page, web: WebStack, ownerToken = web.relay.ownerToken) => {
  const relayField = page.getByRole("textbox", { name: "Relay", exact: true })
  if (!(await relayField.isVisible()))
    await page.getByRole("button", { name: "Use another relay", exact: true }).click()
  await relayField.fill(web.relay.url)
  await page.getByRole("textbox", { name: "Owner token", exact: true }).fill(ownerToken)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
}

export const openSignedIn = async (page: Page, web: WebStack) => {
  await page.goto(web.appUrl)
  await signIn(page, web)
  await expect(sidebar(page)).toBeVisible()
}

export const openMachineResources = async (page: Page) => {
  await page.getByRole("button", { name: "Machine resources", exact: true }).click()
  return page.getByRole("dialog")
}

export const addProject = async (page: Page, path: string, name: string) => {
  await page.getByRole("button", { name: "Add project", exact: true }).first().click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Folder or GitHub repository", { exact: true }).fill(path)
  await dialog.getByLabel("Name", { exact: true }).fill(name)
  await dialog.getByRole("button", { name: "Add project", exact: true }).click()
  await expect(dialog).toBeHidden()
}

export const startThread = async (page: Page, web: WebStack, project: string) => {
  await page.getByRole("button", { name: `New thread in ${project}`, exact: true }).click()
  await expect(
    page.getByRole("heading", { name: `What do you want to work on ${project} in ${web.machine.name}?`, exact: true }),
  ).toBeVisible()
}

export const sendMessage = async (page: Page, message: string) => {
  await page.getByRole("combobox", { name: "Message", exact: true }).fill(message)
  await page.getByRole("button", { name: "Send", exact: true }).click()
}

export const openFile = async (page: Page, file: string) => {
  const details = page.getByRole("complementary", { name: "Thread details" })
  await details.getByRole("tab", { name: "Files", exact: true }).click()
  await page.getByRole("tree", { name: "Workspace files" }).getByRole("treeitem", { name: file, exact: true }).click()
}
