import { expect, type Page } from "@playwright/test"
import { Then, When } from "../support/fixtures.ts"

const paletteInput = (page: Page) => page.getByRole("dialog").getByRole("combobox", { name: "Search", exact: true })

When("I type {string} into the palette", async ({ app }, text: string) => {
  await paletteInput(app.page).pressSequentially(text)
})

When("I type the name of the thread {string} into the palette", async ({ app, names }, title: string) => {
  await paletteInput(app.page).pressSequentially(names.of(title))
})

Then("the first palette result is {string}", async ({ app, names }, title: string) => {
  await expect(app.page.getByRole("option").first()).toContainText(names.of(title))
})

Then("the first palette result reads {string}", async ({ app }, text: string) => {
  await expect(app.page.getByRole("option").first()).toContainText(text)
})

Then("the new thread picker lists the projects", async ({ app }) => {
  await expect(paletteInput(app.page)).toHaveAttribute("placeholder", "Pick a project for the new thread")
  await expect(app.page.getByRole("option").first()).toBeVisible()
})

Then("the palette is closed", async ({ app }) => {
  await expect(app.page.getByRole("dialog")).toBeHidden()
})
