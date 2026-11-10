import { expect, type Page } from "@playwright/test"
import { Then, When, type Names } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

const routineRow = (page: Page, names: Names, name: string) =>
  page.getByRole("listitem").filter({ has: page.getByText(names.of(name), { exact: true }) })

const routineId = async (page: Page, names: Names, name: string) => {
  const routine = (await rpc(page, "routines.list", undefined)).find((item) => item.name === names.of(name))
  if (!routine) throw new Error(`no routine named ${name} was created in this scenario`)
  return routine.id
}

const deliver = async (page: Page, names: Names, name: string, secret: string) => {
  const { url } = await rpc(page, "routines.webhook", { id: await routineId(page, names, name) })
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "text/plain" },
    body: "ping",
  })
  return { status: response.status, body: await response.text() }
}

When(
  "I create a routine named {string} in {string} that runs every day at {string}",
  async ({ app, names }, name: string, project: string, time: string) => {
    const page = app.page
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Routines" }).click()
    await page.getByRole("button", { name: "New routine", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Name", { exact: true }).fill(names.of(name))
    await dialog.getByLabel("Project", { exact: true }).click()
    await page.getByRole("option", { name: names.of(project), exact: true }).click()
    await dialog.getByRole("tab", { name: "Daily", exact: true }).click()
    await dialog.getByLabel("Time", { exact: true }).fill(time)
    await expect(dialog.getByRole("list", { name: /^Next runs/ }).getByRole("listitem")).toHaveCount(7)
    const prompt = dialog.getByRole("combobox", { name: "Prompt", exact: true })
    await prompt.click()
    await prompt.pressSequentially("Reply with ping only.")

    await expect(dialog.getByPlaceholder("Loading models…")).toHaveCount(0, { timeout: 30_000 })
    const model = dialog.getByLabel("Model", { exact: true })
    if ((await model.getAttribute("role")) === "combobox") {
      await model.click()
      await page.getByRole("option").first().click()
    } else if ((await model.inputValue()) === "") {
      await model.fill("claude-sonnet-5-5")
    }

    await dialog.getByRole("button", { name: "Create routine", exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(routineRow(page, names, name)).toBeVisible({ timeout: 2_000 })
  },
)

Then("the routine {string} runs {string}", async ({ app, names }, name: string, schedule: string) => {
  const words = new RegExp(`^${schedule.replaceAll(" ", "\\s")}$`)
  await expect(routineRow(app.page, names, name).getByText(words)).toBeVisible()
})

Then("the routine {string} has a next run", async ({ app, names }, name: string) => {
  await expect(routineRow(app.page, names, name).getByText(/^Next /)).toBeVisible()
})

Then("the routine {string} has no next run", async ({ app, names }, name: string) => {
  await expect(routineRow(app.page, names, name).getByText(/^Next /)).toHaveCount(0)
})

When("I disable the routine {string}", async ({ app, names }, name: string) => {
  const toggle = app.page.getByRole("switch", { name: `Enable ${names.of(name)}`, exact: true })
  await toggle.click()
  await expect(toggle).not.toBeChecked()
})

When("I run the routine {string} now", async ({ app, names }, name: string) => {
  await app.page.getByRole("button", { name: `Run ${names.of(name)} now`, exact: true }).click()
})

Then("the run history of {string} links to the thread it started", async ({ app, names }, name: string) => {
  const row = routineRow(app.page, names, name)
  await row.locator("button[aria-expanded]").first().click()
  const runs = row.getByRole("region", { name: "Recent runs" })
  await expect(runs.getByText("Run now", { exact: true })).toBeVisible({ timeout: 10_000 })
  await runs.getByRole("link", { name: "Open thread" }).first().click()
  await expect(app.page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible()
})

When("I get a new webhook secret for {string}", async ({ app, names, webhook }, name: string) => {
  const page = app.page
  const row = routineRow(page, names, name)
  await row.locator("button[aria-expanded]").first().click()
  const create = row.getByRole("button", { name: "Create secret", exact: true })
  const rotate = row.getByRole("button", { name: "Rotate secret", exact: true })
  await expect(create.or(rotate)).toBeVisible()
  if (await rotate.isVisible()) {
    await rotate.click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Rotate secret", exact: true }).click()
  } else {
    await create.click()
  }
  const shown = page.getByRole("dialog", { name: "Webhook secret" })
  const secret = (await shown.getByLabel("Secret", { exact: true }).textContent())?.trim() ?? ""
  webhook.secrets.set(name, secret)
  await shown.getByRole("button", { name: "Done", exact: true }).click()
  await expect(shown).toBeHidden()
})

When(
  "a delivery for {string} with the secret as a bearer token arrives",
  async ({ app, names, webhook }, name: string) => {
    const secret = webhook.secrets.get(name)
    if (secret === undefined) throw new Error(`get a webhook secret for ${name} first`)
    webhook.response = await deliver(app.page, names, name, secret)
  },
)

When("a delivery for {string} with the wrong secret arrives", async ({ app, names, webhook }, name: string) => {
  webhook.response = await deliver(app.page, names, name, "not-the-secret")
})

Then("the delivery is accepted", ({ webhook }) => {
  expect(webhook.response?.status).toBe(202)
})

Then("the delivery is rejected with {int}", ({ webhook }, status: number) => {
  expect(webhook.response?.status).toBe(status)
})
