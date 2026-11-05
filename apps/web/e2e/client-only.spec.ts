import type { Page } from "@playwright/test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { desktopOnlyMethods, type RpcMethod } from "../../../src/shared/contract.ts"
import { addProject, openFile, openSignedIn, sendMessage, startThread } from "./support/app.ts"
import { expect, test } from "./support/fixtures.ts"

const recordMachineCalls = (page: Page) => {
  const methods = new Set<string>()
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const frame = typeof payload === "string" ? (JSON.parse(payload) as { type?: string; method?: string }) : {}
      if (frame.type === "call" && frame.method !== undefined) methods.add(frame.method)
    }),
  )
  return methods
}

const recordLocalLoads = (page: Page) => {
  const urls: Array<string> = []
  page.on("request", (request) => {
    if (/^(?:file|hinacode-[a-z]+):/.test(request.url())) urls.push(request.url())
  })
  return urls
}

const LOCAL_MACHINE_CONTROLS = [/^This machine$/, /^Browse…$/, /^Reveal in /, /^Open with/, /^Export/]

const expectNoLocalMachineControls = async (page: Page) => {
  for (const name of LOCAL_MACHINE_CONTROLS) {
    await expect(page.getByText(name)).toHaveCount(0)
    await expect(page.getByRole("button", { name })).toHaveCount(0)
  }
}

const openSettings = (page: Page) => page.getByRole("link", { name: "Settings", exact: true }).click()

const settingsSections = (page: Page) => page.getByRole("navigation", { name: "Settings sections" })

const visitEverySettingsPage = async (page: Page) => {
  await openSettings(page)
  const sections = settingsSections(page).getByRole("listitem").getByRole("button")
  await expect(sections.first()).toBeVisible()
  const pages = await sections.all()
  expect(pages.length).toBeGreaterThan(3)
  for (const section of pages) {
    await section.click()
    await expect(page.getByRole("heading", { level: 1, name: (await section.textContent()) ?? "" })).toBeVisible()
    await expectNoLocalMachineControls(page)
  }
}

test.describe("the web app is a client of remote machines", () => {
  test("it sends a machine only the rpc a machine serves", async ({ page, web, repo, uniqueName }) => {
    const project = uniqueName("client")
    writeFileSync(join(repo, "notes.md"), "# Notes\n")
    const methods = recordMachineCalls(page)
    const localLoads = recordLocalLoads(page)

    await openSignedIn(page, web)
    await addProject(page, repo, project)
    await startThread(page, web, project)
    await sendMessage(page, "Show me some Markdown")
    await expect(page.locator("article[aria-busy='false']")).toBeVisible()
    await openFile(page, "notes.md")
    await expect(page.getByRole("heading", { name: "Notes", exact: true })).toBeVisible()
    await visitEverySettingsPage(page)

    expect(methods).toContain("projects.create" satisfies RpcMethod)
    expect([...methods].filter((method) => desktopOnlyMethods.has(method as RpcMethod))).toEqual([])
    expect(localLoads).toEqual([])
  })

  test("it offers no local machine and no local files", async ({ page, web, repo, uniqueName }) => {
    const project = uniqueName("local")
    await openSignedIn(page, web)
    await expectNoLocalMachineControls(page)
    await page.getByRole("button", { name: "Add project", exact: true }).first().click()
    const dialog = page.getByRole("dialog", { name: "Add project", exact: true })
    const where = dialog.getByRole("combobox", { name: "Where", exact: true })
    await expect(where).toHaveText(web.machine.name)
    await where.click()
    await expect(page.getByRole("option")).toHaveText([web.machine.name])
    await page.getByRole("option", { name: web.machine.name, exact: true }).click()
    await expectNoLocalMachineControls(page)
    await page.keyboard.press("Escape")
    await addProject(page, repo, project)
    await startThread(page, web, project)
    await expectNoLocalMachineControls(page)
  })

  test("it keeps its own settings in the browser", async ({ page, web }) => {
    const methods = recordMachineCalls(page)
    await openSignedIn(page, web)
    await openSettings(page)
    await settingsSections(page).getByRole("button", { name: "Appearance", exact: true }).click()
    await page.getByText("Hina Dark", { exact: true }).click()
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("hinacode.clientSettings") ?? "{}"))
    expect(stored).toMatchObject({ appearance: { theme: "hina-dark" } })
    expect([...methods].filter((method) => method.startsWith("clientSettings."))).toEqual([])
    await page.reload()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "hina-dark")
  })
})
