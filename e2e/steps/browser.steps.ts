import { expect, type Page } from "@playwright/test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { WebviewElement } from "../../src/renderer/lib/elementPicker.ts"
import { Given, Then, When } from "../support/fixtures.ts"
import { servePageFrom } from "../support/listener.ts"
import { threadView } from "../support/ui.ts"

// The hero fills the page, so the first arrow key lands on it; the button sits above it at a known spot.
const SHOP_PAGE = `<!doctype html>
<title>Shop</title>
<body style="margin:0">
  <section class="hero" style="position:fixed;inset:0">
    <h1 style="position:absolute;left:16px;bottom:16px;margin:0">Welcome</h1>
  </section>
  <button class="buy primary" style="position:fixed;left:0;top:0;width:200px;height:80px" onclick="document.title = 'clicked'">Buy now</button>
</body>`

const webview = (page: Page) => page.locator("webview")

/** Runs `code` in the browsed page, or resolves null while the page cannot run scripts yet. */
const inPage = (page: Page, code: string) =>
  webview(page).evaluate((view, script) => (view as WebviewElement).executeJavaScript(script).catch(() => null), code)

Given("my repository serves a shop page", async ({ repo, listeners }) => {
  writeFileSync(join(repo, "index.html"), SHOP_PAGE)
  listeners.set("shop", await servePageFrom(repo))
})

const openShop = async (page: Page, port: number, query: string) => {
  const browser = await threadView(page, "Browser")
  await browser.getByRole("textbox", { name: "Address", exact: true }).fill(`localhost:${port}/${query}`)
  await browser.getByRole("textbox", { name: "Address", exact: true }).press("Enter")
  await expect.poll(() => inPage(page, "document.readyState")).toBe("complete")
  return browser
}

const startPicking = async (page: Page) => {
  await (await threadView(page, "Browser")).getByRole("button", { name: "Select element", exact: true }).click()
  await expect.poll(() => inPage(page, "Boolean(window.__kkcodePicker)")).toBe(true)
}

When("I open the shop page in the browser", async ({ app, listeners }) => {
  await openShop(app.page, listeners.get("shop")!.port, "")
})

When("I open the shop page with a {int}-character query in the browser", async ({ app, listeners }, length: number) => {
  await openShop(app.page, listeners.get("shop")!.port, `?q=${"a".repeat(length)}`)
})

When("I click the Buy now button while selecting an element", async ({ app }) => {
  await startPicking(app.page)
  const box = await webview(app.page).boundingBox()
  if (!box) throw new Error("the browser view is not on screen")
  await app.page.mouse.move(box.x + 100, box.y + 40)
  await app.page.mouse.click(box.x + 100, box.y + 40)
})

When("I pick the heading with the keyboard", async ({ app }) => {
  await startPicking(app.page)
  await app.page.keyboard.press("ArrowDown")
  await app.page.keyboard.press("ArrowDown")
  await app.page.keyboard.press("Enter")
})

Then("the message has the element {string}", async ({ app }, label: string) => {
  await expect(app.page.getByRole("img", { name: `Element ${label}`, exact: true })).toBeVisible()
})

Then("the shop page did not see the click", async ({ app }) => {
  expect(await inPage(app.page, "document.title")).toBe("Shop")
})
