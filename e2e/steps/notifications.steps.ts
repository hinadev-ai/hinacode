import { expect, type Page } from "@playwright/test"
import type { AgentEvent } from "../../src/shared/agent.ts"
import { defaultClientSettings } from "../../src/shared/domain.ts"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

interface Captured {
  readonly title: string
  readonly body: string
}

declare global {
  interface Window {
    captured?: Array<Notification>
  }
}

const eventsByType = (threadId: string): Record<string, AgentEvent> => ({
  turn_completed: { type: "turn_completed" },
  approval_requested: {
    type: "approval_requested",
    request: { id: "approval-1", threadId, provider: "claude", kind: "command", title: "Run pnpm test", detail: "" },
  },
  question_requested: {
    type: "question_requested",
    request: {
      id: "question-1",
      threadId,
      provider: "claude",
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Which branch should I use?",
          options: [{ label: "main", description: "Main branch" }],
          multiSelect: false,
          allowsText: true,
          secret: false,
        },
      ],
    },
  },
  secret_requested: {
    type: "secret_requested",
    request: { id: "secret-1", threadId, name: "NPM_TOKEN", description: "Publish the package" },
  },
  turn_failed: { type: "turn_failed", message: "Turn interrupted" },
  turn_limited: { type: "turn_limited", limit: { kind: "usage", message: "You've hit your limit", reset: null } },
})

const captured = (page: Page) =>
  page.evaluate(() =>
    (window.captured ?? []).map((notification): Captured => ({ title: notification.title, body: notification.body })),
  )

Given("every notification kind is turned on", async ({ app }) => {
  await rpc(app.page, "clientSettings.set", { notifications: defaultClientSettings.notifications })
  await app.reload()
})

Given("desktop notifications are captured", async ({ app }) => {
  await app.page.evaluate(() => {
    const notifications: Array<Notification> = []
    window.captured = notifications
    window.Notification = class extends EventTarget {
      readonly title: string
      readonly body: string
      constructor(title: string, options: NotificationOptions = {}) {
        super()
        this.title = title
        this.body = options.body ?? ""
        notifications.push(this as unknown as Notification)
      }
      close() {}
    } as unknown as typeof Notification
  })
})

Given("the window has focus", async ({ app }) => {
  await app.page.evaluate(() => {
    document.hasFocus = () => true
  })
})

Given("the window does not have focus", async ({ app }) => {
  await app.page.evaluate(() => {
    document.hasFocus = () => false
  })
})

When("the agent in {string} emits {string}", async ({ app, threadIds }, title: string, type: string) => {
  const threadId = threadIds.get(title)
  if (!threadId) throw new Error(`no seeded thread titled ${title}`)
  const event = eventsByType(threadId)[type]
  if (!event) throw new Error(`no sample event of type ${type}`)
  const { seq } = await rpc(app.page, "threads.transcript", { threadId })
  await app.pushEvents([{ type: "thread.event", threadId, seq: seq + 1, event }])
})

When("I click the notification for {string}", async ({ app, names }, title: string) => {
  await expect.poll(() => captured(app.page)).toContainEqual(expect.objectContaining({ title: names.of(title) }))
  await app.page.evaluate((name) => {
    const notification = window.captured?.find((candidate) => candidate.title === name)
    notification?.dispatchEvent(new Event("click"))
  }, names.of(title))
})

When("I turn off the setting {string}", async ({ app }, label: string) => {
  const toggle = app.page.getByRole("switch", { name: label, exact: true })
  await toggle.click()
  await expect(toggle).not.toBeChecked()
})

Then(
  "the only notification is for {string} and reads {string}",
  async ({ app, names }, title: string, body: string) => {
    await expect.poll(() => captured(app.page)).toEqual([{ title: names.of(title), body }])
  },
)

const toasts = (page: Page) => page.locator("[data-sonner-toast]")

Then("the only toast is for {string} and reads {string}", async ({ app, names }, title: string, body: string) => {
  await expect(toasts(app.page)).toHaveCount(1)
  await expect(toasts(app.page).locator("[data-title]")).toHaveText(names.of(title))
  await expect(toasts(app.page).locator("[data-description]")).toHaveText(body)
})

Then("no desktop notification was shown", async ({ app }) => {
  expect(await captured(app.page)).toEqual([])
})

When("I open the toast for {string}", async ({ app, names }, title: string) => {
  await toasts(app.page)
    .filter({ hasText: names.of(title) })
    .getByRole("button", { name: "Open", exact: true })
    .click()
})

When("I minimize the notification window", async ({ app }) => {
  await app.minimize()
  await expect.poll(() => app.windowState()).toMatchObject({ minimized: true })
})

Then("the notification window is restored and focused", async ({ app }) => {
  await expect.poll(() => app.windowState()).toStrictEqual({ minimized: false, focused: true })
})
