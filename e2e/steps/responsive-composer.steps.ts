import { expect } from "@playwright/test"
import { Given, Then, When } from "../support/fixtures.ts"

Given(
  "the project {string} has an {word} responsive thread {string}",
  async ({ app, seed, names, projectIds }, project: string, status: string, title: string) => {
    const projectId = projectIds.get(project)
    if (!projectId) throw new Error(`no seeded project named ${project}`)
    if (status !== "idle" && status !== "running") throw new Error(`unsupported thread status ${status}`)
    await app.setWindow({ width: 1280, height: 820, zoom: 1 })
    await app.page.setViewportSize({ width: 1280, height: 820 })
    seed.thread({ projectId, title: names.of(title), status })
    await app.reload()
  },
)

When("I enlarge the minimum window to 200 percent", async ({ app }) => {
  const title = await app.page.getByRole("heading", { level: 1 }).innerText()
  await app.restart()
  await app.page
    .getByRole("navigation", { name: "Projects and threads" })
    .getByRole("link", { name: title, exact: true })
    .click()
  const pixelRatio = await app.page.evaluate(() => devicePixelRatio)
  await app.setWindow({ width: 720, height: 480, zoom: 2 })
  await expect
    .poll(() =>
      app.page.evaluate(() => ({ width: innerWidth, pixelRatio: devicePixelRatio, heightFits: innerHeight <= 240 })),
    )
    .toEqual({
      width: 360,
      pixelRatio: pixelRatio * 2,
      heightFits: true,
    })
})

When(
  "I use a {int} by {int} viewport with {int} pixel text",
  async ({ app }, width: number, height: number, fontSize: number) => {
    await app.page.setViewportSize({ width, height })
    await app.page.evaluate((size) => {
      document.documentElement.style.fontSize = `${size}px`
    }, fontSize)
  },
)

When("I compose a long draft", async ({ app }) => {
  await app.page.getByLabel("Message", { exact: true }).fill("A draft that remains editable.\n".repeat(30))
})

When("I paste {int} images into the message", async ({ app }, count: number) => {
  await app.page.getByLabel("Message", { exact: true }).evaluate((node, imageCount) => {
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6DboAAAAASUVORK5CYII="),
      (character) => character.charCodeAt(0),
    )
    const clipboardData = new DataTransfer()
    for (let index = 0; index < imageCount; index++) {
      clipboardData.items.add(new File([png], `image-${index}.png`, { type: "image/png" }))
    }
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))
  }, count)
  await expect(app.page.getByRole("button", { name: /^Remove image-/ })).toHaveCount(count)
})

Then("the message field and {word} action fit inside the window", async ({ app }, action: string) => {
  const page = app.page
  const textarea = page.getByLabel("Message", { exact: true })
  const button = page.getByRole("button", { name: action, exact: true })
  await expect(button).toBeEnabled()
  await expect
    .poll(
      async () => {
        const field = await textarea.boundingBox()
        const control = await button.boundingBox()
        const lineHeight = await textarea.evaluate((node) => {
          const style = getComputedStyle(node)
          return (
            Number.parseFloat(style.lineHeight) +
            Number.parseFloat(style.paddingTop) +
            Number.parseFloat(style.paddingBottom)
          )
        })
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        return {
          usableWidth: field !== null && field.width >= 200,
          usableHeight: field !== null && field.height >= lineHeight,
          fieldVisible: field !== null && field.x >= 0 && field.y >= 0 && field.y + field.height <= viewport.height,
          actionVisible:
            control !== null &&
            control.x >= 0 &&
            control.y >= 0 &&
            control.x + control.width <= viewport.width &&
            control.y + control.height <= viewport.height,
        }
      },
      { message: "textarea and message action stay usable without manually hiding panels" },
    )
    .toEqual({ usableWidth: true, usableHeight: true, fieldVisible: true, actionVisible: true })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

Then("I can open and dismiss both secondary panels with the keyboard", async ({ app }) => {
  for (const [label, title] of [
    ["Show sidebar", "Projects and threads"],
    ["Show thread details", "Thread details"],
  ]) {
    const trigger = app.page.getByRole("button", { name: label, exact: true })
    await trigger.focus()
    await app.page.keyboard.press("Enter")
    const dialog = app.page.getByRole("dialog", { name: title, exact: true })
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    await app.page.keyboard.press("Tab")
    await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    await app.page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
  }
})
