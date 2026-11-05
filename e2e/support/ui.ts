import type { Locator, Page } from "@playwright/test"

export const sidebar = (page: Page) => page.getByRole("navigation", { name: "Projects and threads" })

export const threadView = async (page: Page, name: "Details" | "Changes" | "Pull requests" | "Browser") => {
  const show = page.getByRole("button", { name: "Show thread details" })
  if (await show.isVisible()) await show.click()
  const panel = page.getByRole("complementary", { name: "Thread details" })
  const tab = panel.getByRole("tab", { name, exact: true })
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click()
  return panel.getByRole("tabpanel", { name, exact: true })
}

export const clickRowButton = async (scope: Locator, name: string) => {
  const button = scope.getByRole("button", { name, exact: true })
  await button.locator("xpath=ancestor::li[1]").hover()
  await button.click()
}

export const threadMenu = async (page: Page, title: string, item: string) => {
  await clickRowButton(sidebar(page), `Actions for ${title}`)
  await page.getByRole("menuitem", { name: item, exact: true }).click()
}

export const composerText = (composer: Locator) =>
  composer.evaluate((editor) => [...editor.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n"))
