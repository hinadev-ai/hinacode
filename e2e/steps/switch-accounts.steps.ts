import { expect } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Given, Then, When } from "../support/fixtures.ts"
import { type HinacodeApp, projectRoot } from "../support/app.ts"
import { rpc } from "../support/rpc.ts"

const originalPrompt = "Check my usage limit"

const screenshot = async (app: HinacodeApp, step: string) => {
  const shots = join(projectRoot, ".context", "shots")
  mkdirSync(shots, { recursive: true })
  const { appearance } = await rpc(app.page, "clientSettings.get", undefined)
  return app.page.screenshot({ path: join(shots, `switch-accounts-${appearance.theme}-${step}.png`) })
}

const onlyThread = async (app: HinacodeApp) => {
  const threads = await rpc(app.page, "threads.list", undefined)
  expect(threads).toHaveLength(1)
  const thread = threads[0]
  if (!thread) throw new Error("Account-limited thread is missing")
  return thread
}

const accountNotice = (app: HinacodeApp) => app.page.getByRole("status").filter({ hasText: /limit reached on/ })
const limitCallout = (app: HinacodeApp) => app.page.getByRole("status").filter({ hasText: "You've hit your limit" })
const accountPicker = (app: HinacodeApp) => app.page.getByRole("combobox", { name: "Account", exact: true })

Given(
  "a Claude thread on {string} with a spent 5-hour window and an added {string} account in the {string} theme",
  async ({ usageLimitApp: app, repo }, cliLogin: string, added: string, theme: string) => {
    if (theme !== "default" && theme !== "light") throw new Error(`Unsupported theme ${theme}`)
    await rpc(app.page, "clientSettings.set", {
      locale: "en",
      appearance: { theme, fontSize: 16, uiFont: null, monoFont: null, contrast: 0 },
    })
    await rpc(app.page, "settings.set", { defaultAccountName: { claude: cliLogin, codex: null, muse: null } })
    const configDir = join(app.userData, "accounts", added)
    mkdirSync(configDir, { recursive: true })
    await rpc(app.page, "accounts.create", { provider: "claude", name: added, configDir, binary: "claude" })
    const project = await rpc(app.page, "projects.create", { name: "Accounts", rootPath: repo, setupScript: null })
    const thread = await rpc(app.page, "threads.create", { projectId: project.id })
    await rpc(app.page, "threads.update", {
      id: thread.id,
      provider: "claude",
      model: "claude-sonnet-5-5",
      title: "Switch accounts",
    })
    await app.reload()
    await app.page
      .getByRole("navigation", { name: "Projects and threads" })
      .getByRole("link")
      .filter({ hasText: "Switch accounts" })
      .click()
  },
)

Then(
  "the thread warns that the 5-hour limit is reached on {string} and offers to switch to {string}",
  async ({ usageLimitApp: app, $testInfo }, cliLogin: string, added: string) => {
    const notice = accountNotice(app)
    await expect(notice.getByText(`5-hour limit reached on ${cliLogin}.`, { exact: true })).toBeVisible()
    await expect(notice).toContainText(/Resets in /)
    await expect(notice.getByRole("button", { name: `Switch to ${added}`, exact: true })).toBeVisible()
    await $testInfo.attach("account-limit-notice", { body: await screenshot(app, "notice"), contentType: "image/png" })
  },
)

When("I send a message to the account-limited thread", async ({ usageLimitApp: app }) => {
  await app.page.getByLabel("Message", { exact: true }).fill(originalPrompt)
  await app.page.getByRole("button", { name: "Send", exact: true }).click()
})

Then(
  "the account-limited thread offers to continue on {string}",
  async ({ usageLimitApp: app, $testInfo }, added: string) => {
    await expect.poll(async () => (await onlyThread(app)).status).toBe("limited")
    await expect(limitCallout(app).getByRole("button", { name: `Continue on ${added}`, exact: true })).toBeVisible()
    await $testInfo.attach("limited-callout", { body: await screenshot(app, "limited"), contentType: "image/png" })
  },
)

When("I continue the account-limited thread on {string}", async ({ usageLimitApp: app }, added: string) => {
  await limitCallout(app)
    .getByRole("button", { name: `Continue on ${added}`, exact: true })
    .click()
})

Then(
  "the thread marks the move from {string} to {string}, continues there and becomes idle",
  async ({ usageLimitApp: app }, cliLogin: string, added: string) => {
    const work = (await rpc(app.page, "accounts.list", undefined)).find((account) => account.name === added)
    if (!work) throw new Error(`Account ${added} is missing`)
    await expect(
      app.page.getByText(`${cliLogin} reached its usage limit. Continued on ${added}.`, { exact: true }),
    ).toBeVisible()
    await expect(app.page.getByText("The retry completed successfully.", { exact: true })).toBeVisible()
    await expect.poll(async () => (await onlyThread(app)).status).toBe("idle")
    const thread = await onlyThread(app)
    expect(thread.accountId).toBe(work.id)
    expect(thread.usageLimit).toBeNull()
    await expect(accountPicker(app)).toContainText(added)
    const { messages } = await rpc(app.page, "threads.transcript", { threadId: thread.id })
    expect(messages.filter((message) => message.role === "user").map((message) => message.parts)).toEqual([
      [{ type: "text", text: originalPrompt }],
      [{ type: "account_switch", from: cliLogin, to: added, automatic: false }],
    ])
    await expect(limitCallout(app)).toBeHidden()
    await expect(accountNotice(app)).toBeHidden()
  },
)

Then(
  "the account picker shows {string} spent and {string} with room",
  async ({ usageLimitApp: app, $testInfo }, cliLogin: string, added: string) => {
    await accountPicker(app).click()
    const options = app.page.getByRole("listbox")
    await expect(options.getByRole("option").filter({ hasText: cliLogin })).toContainText(/Limit reached, resets in \S/)
    await expect(options.getByRole("option").filter({ hasText: added })).toContainText("12% used")
    await $testInfo.attach("account-picker", { body: await screenshot(app, "picker"), contentType: "image/png" })
    await app.page.keyboard.press("Escape")
  },
)
