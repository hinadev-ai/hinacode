import type { Page } from "@playwright/test"

export const sidebar = (page: Page) => page.getByRole("navigation", { name: "Projects and threads" })

/** The thread details panel, opened first if the user had hidden it. */
export const threadDetails = async (page: Page) => {
  const show = page.getByRole("button", { name: "Show thread details" })
  if (await show.isVisible()) await show.click()
  return page.getByRole("complementary", { name: "Thread details" })
}

/** Opens the row menu of a sidebar thread and picks an item. */
export const threadMenu = async (page: Page, title: string, item: string) => {
  await sidebar(page)
    .getByRole("button", { name: `Actions for ${title}`, exact: true })
    .click()
  await page.getByRole("menuitem", { name: item, exact: true }).click()
}
