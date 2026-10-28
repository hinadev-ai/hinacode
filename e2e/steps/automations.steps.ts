import { expect } from "@playwright/test"
import { createHmac } from "node:crypto"
import { Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

const deliver = async (url: string, body: string, signature: string | null) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "x-hinacode-signature": signature } : {}) },
    body,
  })
  return { status: response.status, body: await response.text() }
}

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

const known = (webhook: { automations: Map<string, { id: string; secret: string; url: string }> }, name: string) => {
  const automation = webhook.automations.get(name)
  if (!automation) throw new Error(`no automation named ${name} was created in this scenario`)
  return automation
}

When(
  "I create a webhook automation named {string} in {string} with the prompt {string}",
  async ({ app, names, webhook }, name: string, project: string, prompt: string) => {
    const page = app.page
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Automations" })
      .click()
    await page.getByRole("button", { name: "New automation", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Name", { exact: true }).fill(names.of(name))
    await dialog.getByLabel("Project", { exact: true }).click()
    await page.getByRole("option", { name: names.of(project), exact: true }).click()
    await dialog.getByLabel("Prompt template", { exact: true }).fill(prompt)
    // Unlike the thread dialog, the form has no default model and stays enabled while the list loads.
    await expect(dialog.getByText("Loading models…")).toBeHidden({ timeout: 30_000 })
    await dialog.getByLabel("Model", { exact: true }).click()
    await page.getByRole("option").first().click()
    await dialog.getByRole("button", { name: "Create automation", exact: true }).click()

    // The signing secret is shown once, right after creation.
    const ready = page.getByRole("dialog", { name: `${names.of(name)} is ready` })
    const secret = (await ready.getByLabel("Signing secret", { exact: true }).textContent())?.trim() ?? ""
    const automation = (await rpc(page, "automations.list", undefined)).find((item) => item.name === names.of(name))
    if (!automation) throw new Error("the automation was not stored")
    const { url } = await rpc(page, "automations.webhookUrl", { id: automation.id })
    webhook.automations.set(name, { id: automation.id, secret, url })
    await ready.getByRole("button", { name: "Done", exact: true }).click()
    await expect(ready).toBeHidden()
    // The list also re-polls every 15 s, so a longer wait would hide a create that skips the refresh.
    await expect(page.getByRole("heading", { name: names.of(name), exact: true })).toBeVisible({ timeout: 2_000 })
  },
)

When("I disable the automation {string}", async ({ app, names }, name: string) => {
  const toggle = app.page.getByRole("switch", { name: `Enable ${names.of(name)}`, exact: true })
  await toggle.click()
  await expect(toggle).not.toBeChecked()
})

When("a delivery for {string} signed with the wrong secret arrives", async ({ webhook }, name: string) => {
  const { url } = known(webhook, name)
  const body = JSON.stringify({ word: "ping" })
  webhook.response = await deliver(url, body, sign("not-the-secret", body))
})

When("a delivery arrives for an automation that does not exist", async ({ webhook }) => {
  const [any] = webhook.automations.values()
  if (!any) throw new Error("create an automation first so the listener address is known")
  const url = any.url.replace(any.id, "00000000-0000-0000-0000-000000000000")
  webhook.response = await deliver(url, "{}", null)
})

When("a signed delivery for {string} arrives", async ({ webhook }, name: string) => {
  const { url, secret } = known(webhook, name)
  const body = JSON.stringify({ word: "ping" })
  webhook.response = await deliver(url, body, sign(secret, body))
})

Then("the automation {string} is listed with a signing secret", ({ webhook }, name: string) => {
  expect(known(webhook, name).secret.length).toBeGreaterThan(16)
})

Then("the delivery is rejected with {int} {string}", ({ webhook }, status: number, error: string) => {
  expect(webhook.response?.status).toBe(status)
  expect(webhook.response?.body).toContain(error)
})
