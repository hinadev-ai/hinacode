import { expect, type Locator, type Page } from "@playwright/test"
import type { HinacodeApp } from "../support/app.ts"
import { type DetailsWidth, Then, When } from "../support/fixtures.ts"
import { sidebar } from "../support/ui.ts"

const detailsView = (page: Page) => page.getByRole("complementary", { name: "Thread details" }).getByRole("tabpanel")
const handle = (page: Page, name: string) => page.getByRole("separator", { name, exact: true })
const widthOf = async (locator: Locator) => Math.round((await locator.boundingBox())?.width ?? 0)

const rememberStart = async (app: HinacodeApp, detailsWidth: DetailsWidth) => {
  detailsWidth.start ??= await widthOf(detailsView(app.page))
}

When(
  "I drag {string} {int} pixels to the {word}",
  async ({ app, detailsWidth }, name: string, distance: number, side: string) => {
    await rememberStart(app, detailsWidth)
    const box = await handle(app.page, name).boundingBox()
    if (!box) throw new Error(`${name} is not visible`)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await app.page.mouse.move(x, y)
    await app.page.mouse.down()
    await app.page.mouse.move(side === "left" ? x - distance : x + distance, y, { steps: 5 })
    await app.page.mouse.up()
  },
)

When(
  "I release {string} {int} pixels to the left without a final move",
  async ({ app, detailsWidth }, name: string, distance: number) => {
    await rememberStart(app, detailsWidth)
    const separator = handle(app.page, name)
    const box = await separator.boundingBox()
    if (!box) throw new Error(`${name} is not visible`)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const session = await app.page.context().newCDPSession(app.page)
    try {
      await app.page.mouse.move(x, y)
      await app.page.mouse.down()
      await expect(separator).toHaveAttribute("data-dragging", "true")
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: x - distance,
        y,
        button: "left",
        clickCount: 1,
      })
    } finally {
      await app.page.mouse.up()
      await session.detach()
    }
  },
)

When("I press {string} on {string}", async ({ app, detailsWidth }, key: string, name: string) => {
  await rememberStart(app, detailsWidth)
  await handle(app.page, name).press(key)
})

When("I double-click {string}", async ({ app }, name: string) => {
  await handle(app.page, name).dblclick()
})

When("I reload the app and open the thread {string}", async ({ app, names }, title: string) => {
  await app.reload()
  await sidebar(app.page)
    .getByRole("link", { name: names.of(title) })
    .click()
})

Then("the thread details panel is {int} pixels wider than it started", async ({ app, detailsWidth }, delta: number) => {
  const { start } = detailsWidth
  if (start === null) throw new Error("no starting width recorded")
  await expect.poll(() => widthOf(detailsView(app.page))).toBe(start + delta)
})

Then("the thread details panel is {int} pixels wide", async ({ app }, width: number) => {
  await expect.poll(() => widthOf(detailsView(app.page))).toBe(width)
})

Then("the sidebar is {int} pixels wide", async ({ app }, width: number) => {
  await expect.poll(() => widthOf(sidebar(app.page))).toBe(width)
})

When("I start dragging {string}", async ({ app }, name: string) => {
  const box = await handle(app.page, name).boundingBox()
  if (!box) throw new Error(`${name} is not visible`)
  await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await app.page.mouse.down()
  await expect.poll(() => app.page.evaluate(() => document.body.style.userSelect)).toBe("none")
})

Then("no resize drag is active", async ({ app }) => {
  try {
    await expect
      .poll(() =>
        app.page.evaluate(() => ({ cursor: document.body.style.cursor, select: document.body.style.userSelect })),
      )
      .toEqual({ cursor: "", select: "" })
  } finally {
    await app.page.mouse.up()
  }
})

Then("the resize maximum matches the displayed panel width", async ({ app }) => {
  await expect
    .poll(async () => Number(await handle(app.page, "Resize thread details").getAttribute("aria-valuemax")))
    .toBe(await widthOf(detailsView(app.page)))
})

When("I press ArrowLeft {int} times on {string}", async ({ app }, count: number, name: string) => {
  for (let index = 0; index < count; index++) await handle(app.page, name).press("ArrowLeft")
})
