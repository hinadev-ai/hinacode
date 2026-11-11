import type { Page } from "@playwright/test"
import { addProject, openSignedIn, sendMessage, startThread } from "./support/app.ts"
import { expect, test } from "./support/fixtures.ts"

test.use({ channel: "chromium" })

const shownNotifications = (page: Page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return (await registration.getNotifications()).map(({ title, body }) => ({ title, body }))
  })

test("a turn that finishes in the background notifies through the service worker", async ({
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
})
