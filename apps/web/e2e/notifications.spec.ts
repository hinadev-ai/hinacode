import type { Page } from "@playwright/test"
import { addProject, openSignedIn, sendMessage, startThread } from "./support/app.ts"
import { expect, test } from "./support/fixtures.ts"

test.use({ channel: "chromium" })

const shownNotifications = (page: Page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return (await registration.getNotifications()).map(({ title, body }) => ({ title, body }))
  })

const clickFirstNotification = `self.registration.getNotifications().then(([notification]) =>
  self.dispatchEvent(new NotificationEvent("notificationclick", { notification })))`

test("a background turn notifies through the service worker, and the notification opens its thread", async ({
  page,
  web,
  repo,
  uniqueName,
}) => {
  const project = uniqueName("notify")
  await page.context().grantPermissions(["notifications"], { origin: new URL(web.appUrl).origin })
  await openSignedIn(page, web)
  await addProject(page, repo, project)
  await startThread(page, web, project)
  await page.evaluate(() => {
    document.hasFocus = () => false
  })
  await sendMessage(page, "Show me some Markdown")
  await expect.poll(() => shownNotifications(page)).toContainEqual(expect.objectContaining({ body: "Finished" }))

  await startThread(page, web, project)
  await expect(page.getByText("Show me some Markdown", { exact: true })).toHaveCount(0)
  const [worker] = page.context().serviceWorkers()
  await worker!.evaluate(clickFirstNotification)
  await expect(page.getByText("Show me some Markdown", { exact: true })).toBeVisible()
})

test("a background turn without notification permission still alerts with a toast", async ({
  page,
  web,
  repo,
  uniqueName,
}) => {
  const project = uniqueName("notify-denied")
  await openSignedIn(page, web)
  await addProject(page, repo, project)
  await startThread(page, web, project)
  expect(await page.evaluate(() => Notification.permission)).not.toBe("granted")
  await page.evaluate(() => {
    document.hasFocus = () => false
  })
  await sendMessage(page, "Show me some Markdown")
  await expect(page.locator("[data-sonner-toast]").getByText("Finished")).toBeVisible()
})
