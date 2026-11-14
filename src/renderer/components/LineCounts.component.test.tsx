import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import "../index.css"
import { LineCounts } from "./LineCounts.tsx"

test("screen readers read the counts as text, not as a label on a span", async () => {
  await render(<LineCounts added={3} removed={1} />)

  await expect.element(page.getByText("3 lines added, 1 removed")).toBeInTheDocument()
})

test("the visible counts stay hidden from screen readers", async () => {
  const { container } = await render(<LineCounts added={3} removed={1} />)

  const visible = [...container.querySelectorAll("[aria-hidden]")].map((node) => node.textContent)
  expect(visible).toEqual(["+3", "−1"])
})

test("copying the counts leaves out the screen reader text", async () => {
  const { container } = await render(
    <p>
      3 files changed <LineCounts added={6} removed={1} /> tail
    </p>,
  )

  const selection = getSelection()!
  selection.selectAllChildren(container)
  expect(selection.toString().trim()).toBe("3 files changed +6 −1 tail")
})
