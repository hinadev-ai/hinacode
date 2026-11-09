import { expect, type Page } from "@playwright/test"
import type { WebStack } from "./fixtures.ts"
import { CLERK_HOST, CLERK_SESSION_TOKEN } from "./stack.ts"

export const sidebar = (page: Page) => page.getByRole("navigation", { name: "Projects and threads" })

const CLERK_SIGNED_IN = "web-e2e.clerk.signedIn"

const clerkUiStub = "window.__internal_ClerkUICtor = function () {}"

const clerkStub = `window.Clerk = {
  isSignedIn: false,
  session: { getToken: async () => ${JSON.stringify(CLERK_SESSION_TOKEN)} },
  load: async () => {
    window.Clerk.isSignedIn = sessionStorage.getItem(${JSON.stringify(CLERK_SIGNED_IN)}) === "1"
  },
  mountSignIn: (element, options) => {
    const button = document.createElement("button")
    button.textContent = "Continue with GitHub"
    button.onclick = () => {
      sessionStorage.setItem(${JSON.stringify(CLERK_SIGNED_IN)}, "1")
      location.assign(options.forceRedirectUrl)
    }
    element.replaceChildren(button)
  },
  unmountSignIn: (element) => element.replaceChildren(),
  signOut: async () => {
    sessionStorage.removeItem(${JSON.stringify(CLERK_SIGNED_IN)})
    window.Clerk.isSignedIn = false
  },
}`

export const stubClerk = async (page: Page) => {
  await page.route("https://relay.hinacode.app/**", (route) => route.abort())
  await page.route(`https://${CLERK_HOST}/**`, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: new URL(route.request().url()).pathname.endsWith("/ui.browser.js") ? clerkUiStub : clerkStub,
    }),
  )
}

export const endClerkSession = (page: Page) => page.evaluate((key) => sessionStorage.removeItem(key), CLERK_SIGNED_IN)

export const signIn = async (page: Page, web: WebStack) => {
  await expect(page.getByRole("heading", { name: "Sign in to HinaCode", exact: true })).toBeVisible()
  const relayField = page.getByRole("textbox", { name: "Relay", exact: true })
  if (!(await relayField.isVisible()))
    await page.getByRole("button", { name: "Use another relay", exact: true }).click()
  await relayField.fill(web.relay.url)
  await page.getByRole("button", { name: "Use this relay", exact: true }).click()
  await page.getByRole("button", { name: "Continue with GitHub", exact: true }).click()
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
    page.getByRole("heading", { name: `What do you want to do in ${project} on ${web.machine.name}?`, exact: true }),
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
