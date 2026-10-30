import { expect } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Given, Then, When } from "../support/fixtures.ts"
import { type HinacodeApp, projectRoot } from "../support/app.ts"
import { rpc } from "../support/rpc.ts"

const limitMessage = "You've hit your limit"
const originalPrompt = "Check my usage limit"
const orgSpendMessage =
  "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 2:10pm (Asia/Tokyo)"
const callout = (app: HinacodeApp, message = limitMessage) => app.page.getByRole("status").filter({ hasText: message })

const screenshot = async (app: HinacodeApp, name: string) => {
  const shots = join(projectRoot, ".context", "shots")
  mkdirSync(shots, { recursive: true })
  return app.page.screenshot({ path: join(shots, `${name}.png`) })
}

const labels = async (app: HinacodeApp) => {
  const { locale } = await rpc(app.page, "clientSettings.get", undefined)
  return locale === "zh-TW"
    ? {
        navigation: "專案與對話串",
        limited: "已達用量上限",
        message: "訊息",
        send: "傳送",
        stop: "停止",
        resume: "重設後繼續",
        cancelResume: "取消自動繼續",
      }
    : {
        navigation: "Projects and threads",
        limited: "Limited",
        message: "Message",
        send: "Send",
        stop: "Stop",
        resume: "Resume at reset",
        cancelResume: "Cancel automatic resume",
      }
}

const onlyThread = async (app: HinacodeApp) => {
  const threads = await rpc(app.page, "threads.list", undefined)
  expect(threads).toHaveLength(1)
  const thread = threads[0]
  if (!thread) throw new Error("Usage-limit thread is missing")
  return thread
}

const openThread = async (app: HinacodeApp) => {
  const thread = await onlyThread(app)
  const copy = await labels(app)
  await app.page
    .getByRole("navigation", { name: copy.navigation })
    .getByRole("link")
    .filter({ hasText: thread.title })
    .click()
}

const createThread = async (app: HinacodeApp, repo: string, locale = "en", theme = "default") => {
  if (locale !== "en" && locale !== "zh-TW") throw new Error(`Unsupported locale ${locale}`)
  if (theme !== "default" && theme !== "light") throw new Error(`Unsupported theme ${theme}`)
  await rpc(app.page, "clientSettings.set", {
    locale,
    appearance: { theme, fontSize: 16, uiFont: null, monoFont: null, contrast: 0 },
  })
  const project = await rpc(app.page, "projects.create", { name: "Usage limits", rootPath: repo, setupScript: null })
  const thread = await rpc(app.page, "threads.create", { projectId: project.id })
  await rpc(app.page, "threads.update", {
    id: thread.id,
    provider: "claude",
    model: "claude-sonnet-5-5",
    title: "Usage limit",
  })
  await app.reload()
  await openThread(app)
}

Given(
  "an isolated usage-limit thread in {string} with the {string} theme",
  async ({ usageLimitApp: app, repo }, locale: string, theme: string) => {
    await createThread(app, repo, locale, theme)
  },
)

const sendMessage = async (app: HinacodeApp, message: string) => {
  const copy = await labels(app)
  await app.page.getByLabel(copy.message, { exact: true }).fill(message)
  await app.page.getByRole("button", { name: copy.send, exact: true }).click()
}

When("I send a message to the usage-limit thread", async ({ usageLimitApp: app }) => {
  await sendMessage(app, originalPrompt)
})

Then("the usage-limit thread is visibly limited and ready to send again", async ({ usageLimitApp: app, $testInfo }) => {
  const copy = await labels(app)
  const thread = await onlyThread(app)
  await expect(
    app.page.getByRole("navigation", { name: copy.navigation }).getByRole("link").filter({ hasText: thread.title }),
  ).toContainText(copy.limited)
  await expect(callout(app).getByText(/^You've hit your limit · resets /)).toBeVisible()
  await expect(callout(app).getByRole("button", { name: copy.resume, exact: true })).toBeVisible()
  await expect(app.page.getByRole("button", { name: copy.stop, exact: true })).toBeHidden()
  await app.page.getByLabel(copy.message, { exact: true }).fill("Retry the task")
  await expect(app.page.getByRole("button", { name: copy.send, exact: true })).toBeEnabled()
  const { locale, appearance } = await rpc(app.page, "clientSettings.get", undefined)
  const scheme = appearance.theme === "light" ? "light" : "dark"
  await $testInfo.attach("limited-thread", {
    body: await screenshot(app, `usage-limit-${locale}-${scheme}`),
    contentType: "image/png",
  })
})

Then("the usage-limit thread remains limited after turn cleanup", async ({ usageLimitApp: app }) => {
  const thread = await onlyThread(app)
  await expect
    .poll(async () => {
      const transcript = await rpc(app.page, "threads.transcript", { threadId: thread.id })
      return transcript.messages.at(-1)?.completedAt
    })
    .toEqual(expect.any(String))
  await expect.poll(async () => (await onlyThread(app)).status).toBe("limited")
  expect((await onlyThread(app)).providerSessionId).not.toBeNull()
  await app.reload()
  await expect.poll(async () => (await onlyThread(app)).status).toBe("limited")
  await openThread(app)
  await expect(callout(app).getByText(/^You've hit your limit · resets /)).toBeVisible()
  expect((await onlyThread(app)).usageLimit).toMatchObject({
    kind: "usage",
    message: expect.stringMatching(/^You've hit your limit · resets /),
    reset: { at: expect.any(String), autoResume: false },
  })
})

When("I restart the usage-limit app", async ({ usageLimitApp: app }) => {
  await app.restart()
  expect((await onlyThread(app)).status).toBe("limited")
  await openThread(app)
})

When("I retry the usage-limit thread", async ({ usageLimitApp: app }) => {
  await sendMessage(app, "Retry the task")
})

const expectCompleted = async (app: HinacodeApp) => {
  const copy = await labels(app)
  await expect(app.page.getByText("The retry completed successfully.", { exact: true })).toBeVisible()
  await expect.poll(async () => (await onlyThread(app)).status).toBe("idle")
  const thread = await onlyThread(app)
  await expect(
    app.page.getByRole("navigation", { name: copy.navigation }).getByRole("link").filter({ hasText: thread.title }),
  ).not.toContainText(copy.limited)
  await expect(app.page.getByRole("button", { name: copy.stop, exact: true })).toBeHidden()
  await expect(callout(app)).toBeHidden()
  expect((await onlyThread(app)).usageLimit).toBeNull()
}

Then("the usage-limit thread completes successfully and becomes idle", async ({ usageLimitApp: app }) => {
  await expectCompleted(app)
})

const scheduleResume = async (app: HinacodeApp) => {
  const copy = await labels(app)
  await callout(app).getByRole("button", { name: copy.resume, exact: true }).click()
  await expect(callout(app).getByRole("button", { name: copy.cancelResume, exact: true })).toBeVisible()
  await expect
    .poll(async () => (await onlyThread(app)).usageLimit)
    .toMatchObject({
      kind: "usage",
      reset: { autoResume: true },
    })
}

Given("an isolated usage-limit thread with a near reset", async ({ automaticResumeApp: app, repo }) => {
  await createThread(app, repo)
})

When("I send a message to the near-reset thread", async ({ automaticResumeApp: app }) => {
  await sendMessage(app, originalPrompt)
})

When("I schedule the near-reset thread to resume at reset", async ({ automaticResumeApp: app }) => {
  await scheduleResume(app)
})

When("I restart the near-reset app with its schedule intact", async ({ automaticResumeApp: app }) => {
  const limit = (await onlyThread(app)).usageLimit
  expect(limit).toMatchObject({ kind: "usage", reset: { autoResume: true } })
  await app.restart()
  expect((await onlyThread(app)).usageLimit).toEqual(limit)
  await openThread(app)
  await expect(callout(app).getByRole("button", { name: "Cancel automatic resume", exact: true })).toBeVisible()
})

Then("the near-reset thread automatically completes with the original prompt", async ({ automaticResumeApp: app }) => {
  await expectCompleted(app)
  const thread = await onlyThread(app)
  await expect
    .poll(async () => {
      const { messages } = await rpc(app.page, "threads.transcript", { threadId: thread.id })
      return messages
        .filter((message) => message.role === "user")
        .map((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"))
    })
    .toEqual([originalPrompt, originalPrompt])
})

When("I schedule the usage-limit thread to resume at reset", async ({ usageLimitApp: app }) => {
  await scheduleResume(app)
})

When("I cancel automatic resume for the usage-limit thread", async ({ usageLimitApp: app }) => {
  const copy = await labels(app)
  await callout(app).getByRole("button", { name: copy.cancelResume, exact: true }).click()
  await expect(callout(app).getByRole("button", { name: copy.resume, exact: true })).toBeVisible()
  await expect
    .poll(async () => (await onlyThread(app)).usageLimit)
    .toMatchObject({
      kind: "usage",
      reset: { autoResume: false },
    })
})

Then("the usage-limit thread has no automatic resume scheduled", async ({ usageLimitApp: app }) => {
  const copy = await labels(app)
  expect((await onlyThread(app)).usageLimit).toMatchObject({ kind: "usage", reset: { autoResume: false } })
  await expect(callout(app).getByRole("button", { name: copy.resume, exact: true })).toBeVisible()
  await expect(callout(app).getByRole("button", { name: copy.cancelResume, exact: true })).toBeHidden()
  const thread = await onlyThread(app)
  const { messages } = await rpc(app.page, "threads.transcript", { threadId: thread.id })
  expect(messages.filter((message) => message.role === "user")).toHaveLength(1)
})

Given("an isolated organization-spend-limit thread", async ({ orgSpendLimitApp: app, repo }) => {
  await createThread(app, repo)
})

When("I send a message to the organization-spend-limit thread", async ({ orgSpendLimitApp: app }) => {
  await sendMessage(app, "Check my organization spend limit")
})

Then(
  "the organization spend limit callout preserves the provider message",
  async ({ orgSpendLimitApp: app, $testInfo }) => {
    const status = callout(app, orgSpendMessage)
    await expect(status.getByRole("heading", { name: "Organization spend limit reached", exact: true })).toBeVisible()
    await expect(status.getByText(orgSpendMessage, { exact: true })).toBeVisible()
    await expect.poll(async () => (await onlyThread(app)).status).toBe("limited")
    expect((await onlyThread(app)).usageLimit).toMatchObject({
      kind: "org_spend",
      message: orgSpendMessage,
      reset: { at: expect.any(String), autoResume: false },
    })
    await $testInfo.attach("org-spend-limit", {
      body: await screenshot(app, "org-spend-limit-en-dark"),
      contentType: "image/png",
    })
  },
)

When("I can schedule the organization-spend-limit thread to resume at reset", async ({ orgSpendLimitApp: app }) => {
  const status = callout(app, orgSpendMessage)
  await status.getByRole("button", { name: "Resume at reset", exact: true }).click()
  await expect(status.getByRole("button", { name: "Cancel automatic resume", exact: true })).toBeVisible()
  await expect
    .poll(async () => (await onlyThread(app)).usageLimit)
    .toMatchObject({ kind: "org_spend", reset: { autoResume: true } })
})
