import { useState } from "react"
import { expect, test } from "vitest"
import { render } from "vitest-browser-react"
import "../index.css"
import { RevealSentinel } from "./RevealSentinel.tsx"
import { ScrollArea } from "./ui/scroll-area.tsx"

const TOTAL = 100
const PAGE = 10

function Rows() {
  const [limit, setLimit] = useState(PAGE)
  return (
    <ScrollArea viewportClassName="h-[200px]">
      <ul>
        {Array.from({ length: Math.min(limit, TOTAL) }, (_, row) => (
          <li key={row} data-testid="row" className="h-10">
            {row}
          </li>
        ))}
      </ul>
      {limit < TOTAL && <RevealSentinel key={limit} onReveal={() => setLimit(limit + PAGE)} />}
    </ScrollArea>
  )
}

const rowCount = () => document.querySelectorAll("[data-testid=row]").length
const viewport = () => document.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!

test("reveals rows only as the scroller nears the end", async () => {
  await render(<Rows />)
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
  const before = rowCount()
  expect(before).toBeLessThan(TOTAL)

  viewport().scrollTop = viewport().scrollHeight
  await expect.poll(rowCount).toBeGreaterThan(before)
})

test("keeps revealing until the end of the list", async () => {
  await render(<Rows />)
  await expect
    .poll(() => {
      viewport().scrollTop = viewport().scrollHeight
      return rowCount()
    })
    .toBe(TOTAL)
})
