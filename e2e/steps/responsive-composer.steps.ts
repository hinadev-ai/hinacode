import { expect } from "@playwright/test"
import { Given, Then, When } from "../support/fixtures.ts"

Given(
  "the project {string} has an {word} responsive thread {string}",
  async ({ app, seed, names, projectIds }, project: string, status: string, title: string) => {
    const projectId = projectIds.get(project)
    if (!projectId) throw new Error(`no seeded project named ${project}`)
    if (status !== "idle" && status !== "running") throw new Error(`unsupported thread status ${status}`)
    await app.page.setViewportSize({ width: 1280, height: 820 })
    seed.thread({ projectId, title: names.of(title), status })
    await app.reload()
  },
)

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
  await app.page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("A draft that remains editable.\n".repeat(30))
})

Then("the message field and {word} action fit inside the window", async ({ app }, action: string) => {
  const page = app.page
  const textarea = page.getByRole("textbox", { name: "Message", exact: true })
  const button = page.getByRole("button", { name: action, exact: true })
  await expect(button).toBeEnabled()
  await expect
    .poll(
      async () => {
        const field = await textarea.boundingBox()
        const control = await button.boundingBox()
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        return {
          usableWidth: field !== null && field.width >= 200,
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
    .toEqual({ usableWidth: true, fieldVisible: true, actionVisible: true })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
