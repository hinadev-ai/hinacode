import type { Page } from "@playwright/test"

export const sidebar = (page: Page) => page.getByRole("navigation", { name: "Projects and threads" })

export const threadView = async (page: Page, name: "Details" | "Changes" | "Pull requests" | "Browser") => {
  const show = page.getByRole("button", { name: "Show thread details" })
  if (await show.isVisible()) await show.click()
  const panel = page.getByRole("complementary", { name: "Thread details" })
  const tab = panel.getByRole("tab", { name, exact: true })
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click()
  return panel.getByRole("tabpanel", { name, exact: true })
}

export const threadMenu = async (page: Page, title: string, item: string) => {
  await sidebar(page)
    .getByRole("button", { name: `Actions for ${title}`, exact: true })
    .click()
  await page.getByRole("menuitem", { name: item, exact: true }).click()
}
