import { expect, test, vi } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { deriveShipReport, shipReportMarkdown } from "../../shared/shipReport.ts"
import "../index.css"
import { ShipReportView } from "./ShipReport.tsx"

const blocked = deriveShipReport({
  threadStatus: "idle",
  changes: {
    files: [{ path: "src/app.ts", status: "modified" }],
    patch: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n",
  },
  pullRequests: [
    {
      url: "https://github.com/hinadev-ai/hinacode/pull/7",
      number: 7,
      title: "Add the thing",
      status: "open",
      checks: "failing",
      review: null,
      mergeable: "mergeable",
    },
  ],
})

test("a blocked report names the verdict, the reason and the change size", async () => {
  await render(<ShipReportView report={blocked} title="Add the thing" />)
  await expect.element(page.getByText("Blocked", { exact: true })).toBeVisible()
  await expect.element(page.getByText("Checks are failing", { exact: true })).toBeVisible()
  await expect.element(page.getByText("1 file changed", { exact: true })).toBeVisible()
})

test("copy puts the Markdown report on the clipboard", async () => {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
  await render(<ShipReportView report={blocked} title="Add the thing" />)
  await page.getByRole("button", { name: "Copy ship report as Markdown" }).click()
  expect(writeText).toHaveBeenCalledWith(shipReportMarkdown(blocked, "Add the thing"))
})

test("a ready report with no pull request says so", async () => {
  const ready = deriveShipReport({
    threadStatus: "idle",
    changes: { files: [{ path: "README.md", status: "added" }], patch: "+hello\n" },
    pullRequests: [],
  })
  await render(<ShipReportView report={ready} title="Docs" />)
  await expect.element(page.getByText("Ready to ship", { exact: true })).toBeVisible()
  await expect.element(page.getByText("No pull request yet", { exact: true })).toBeVisible()
})
