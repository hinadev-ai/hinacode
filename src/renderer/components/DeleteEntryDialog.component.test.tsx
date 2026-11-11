import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { FsEntry } from "../../shared/domain.ts"
import "../index.css"
import { DeleteEntryDialog } from "./DeleteEntryDialog.tsx"

const entry: FsEntry = { name: "notes.md", path: "/app/notes.md", kind: "file", ignored: false, gitStatus: null }

test("the title keeps the entry's name while the dialog closes", async () => {
  const screen = await render(<DeleteEntryDialog entry={entry} onCancel={() => {}} onDelete={() => {}} />)
  const title = page.getByRole("alertdialog").getByRole("heading")
  await expect.element(title).toHaveTextContent("Delete notes.md?")

  await screen.rerender(<DeleteEntryDialog entry={null} onCancel={() => {}} onDelete={() => {}} />)

  const closing = document.querySelector('[role="alertdialog"] h2')
  expect(closing?.textContent).toBe("Delete notes.md?")
})
