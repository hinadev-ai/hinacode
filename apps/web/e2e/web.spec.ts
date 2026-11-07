import type { Page } from "@playwright/test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  addProject,
  openFile,
  openMachineResources,
  openRelaySignInPage,
  openSignedIn,
  sidebar,
  signIn,
  startThread,
} from "./support/app.ts"
import { expect, test } from "./support/fixtures.ts"

const browserCredential = (page: Page) =>
  page.evaluate(
    () => (JSON.parse(localStorage.getItem("hinacode.relayAccount") ?? "{}") as { credential: string }).credential,
  )

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

test("signing in through the relay's page loads the app with the relay's machines", async ({ page, web }) => {
  await page.goto(web.appUrl)
  await expect(page.getByRole("textbox", { name: "Owner token" })).toHaveCount(0)
  await signIn(page, web)
  const resources = await openMachineResources(page)
  await expect(resources.getByText(web.machine.name, { exact: true })).toBeVisible()
  expect(web.relay.deviceName(await browserCredential(page))).toBe("HinaCode in a browser")
})

test("a sign-in denied on the relay's page stops waiting and says so", async ({ page, web }) => {
  web.relay.denyNextSignIn()
  await page.goto(web.appUrl)
  const denial = await openRelaySignInPage(page, web)
  await expect(denial.getByText(/^Denied /)).toBeVisible()
  await denial.close()
  await expect(page.getByRole("alert")).toHaveText("The sign-in was denied. Sign in again.")
  await expect(page.getByText("Waiting for you to approve this browser…", { exact: true })).toHaveCount(0)
})

test("logging out ends this browser's sign-in on the relay", async ({ page, web }) => {
  await openSignedIn(page, web)
  const credential = await browserCredential(page)
  await page.getByRole("button", { name: "Account", exact: true }).click()
  await expect(page.getByText("Web E2E", { exact: true })).toBeVisible()
  await page.getByRole("menuitem", { name: "Logout", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Sign out", exact: true }).click()
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
  expect(web.relay.deviceName(credential)).toBeUndefined()
})

test("a browser the relay signed out goes back to sign in", async ({ page, web }) => {
  await openSignedIn(page, web)
  web.relay.signOutEveryDevice()
  await page.reload()
  await expect(page.getByRole("alert")).toHaveText("This browser was signed out. Sign in again.")
  await page.reload()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
})

test("reloading goes straight back to the app", async ({ page, web }) => {
  await openSignedIn(page, web)
  await page.reload()
  await expect(sidebar(page)).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Owner token", exact: true })).toHaveCount(0)
})

test("a hard reload, which skips the service worker, still loads the app", async ({ page, web }) => {
  await openSignedIn(page, web)
  const devtools = await page.context().newCDPSession(page)
  await devtools.send("Page.reload", { ignoreCache: true })
  await expect(sidebar(page)).toBeVisible()
})

test("markup injected into the page cannot run script", async ({ page, web }) => {
  await openSignedIn(page, web)
  const ran = await page.evaluate(async () => {
    const host = document.createElement("div")
    host.innerHTML = `<img src="data:," onerror="window.injected = true">`
    const image = host.querySelector("img")!
    const failed = new Promise((resolve) => image.addEventListener("error", resolve))
    document.body.append(host)
    await failed
    host.remove()
    return "injected" in window
  })
  expect(ran).toBe(false)
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

test("an HTML preview stays sandboxed after it navigates", async ({ page, web, repo, uniqueName }) => {
  const project = uniqueName("html")
  const elsewhere = "https://elsewhere.example/"
  await page.route(elsewhere, (route) => route.fulfill({ contentType: "text/html", body: "<p>Elsewhere</p>" }))
  writeFileSync(join(repo, "pixel.png"), Buffer.from(ONE_PIXEL_PNG, "base64"))
  writeFileSync(
    join(repo, "page.html"),
    `<img src="pixel.png" alt="pixel"><button onclick="location.href = '${elsewhere}'">Leave</button>`,
  )
  await openSignedIn(page, web)
  await addProject(page, repo, project)
  await startThread(page, web, project)
  await openFile(page, "page.html")
  const preview = page.frameLocator('iframe[title="page.html"]')
  await expect(preview.getByRole("img", { name: "pixel" })).toHaveJSProperty("naturalWidth", 1)
  expect(await preview.locator("body").evaluate(() => origin)).toBe("null")
  await preview.getByRole("button", { name: "Leave" }).click()
  await expect(preview.getByText("Elsewhere")).toBeVisible()
  expect(await preview.locator("body").evaluate(() => window.open("about:blank") !== null)).toBe(false)
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
