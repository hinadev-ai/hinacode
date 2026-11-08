import { expect, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import "../../index.css"
import { Button } from "./button.tsx"
import { Slider } from "./slider.tsx"

async function snapshotPixels() {
  const base64 = await page.screenshot({ save: false, scale: "css" })
  const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext("2d")!
  context.drawImage(bitmap, 0, 0)
  return (x: number, y: number) => Array.from(context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data)
}

async function ringShowsAt(target: HTMLElement, x: number, y: number) {
  target.blur()
  const blurred = (await snapshotPixels())(x, y)
  target.focus({ focusVisible: true })
  const focused = (await snapshotPixels())(x, y)
  return focused.some((channel, index) => Math.abs(channel - blurred[index]!) > 4)
}

test("a slider shows a ring when its thumb takes keyboard focus", async () => {
  await render(<Slider aria-label="Volume" defaultValue={50} className="w-40" />)
  await userEvent.tab()
  const thumb = document.querySelector<HTMLElement>("[data-slot=slider-thumb]")!
  const input = thumb.querySelector("input")!
  const box = thumb.getBoundingClientRect()

  expect(await ringShowsAt(input, box.right + 1.5, box.top + box.height / 2)).toBe(true)
})

test("a pressed neighbour does not paint over a button's ring", async () => {
  await render(
    <div className="flex p-4">
      <Button variant="ghost" size="icon-sm" aria-label="Expand">
        E
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Toggle" aria-expanded>
        T
      </Button>
    </div>,
  )
  const expand = page.getByRole("button", { name: "Expand" }).element() as HTMLElement
  const box = expand.getBoundingClientRect()

  expect(await ringShowsAt(expand, box.right + 1.5, box.top + box.height / 2)).toBe(true)
})

test("focus scrolls a partly visible button until its ring clears the scroller's edge", async () => {
  await render(
    <div className="flex h-20 flex-col overflow-y-auto">
      {Array.from({ length: 10 }, (_, index) => (
        <Button key={index} variant="ghost" className="shrink-0">
          Row {index}
        </Button>
      ))}
    </div>,
  )
  const partlyVisible = page.getByRole("button", { name: "Row 2" }).element() as HTMLElement
  partlyVisible.focus({ focusVisible: true })
  const scroller = partlyVisible.parentElement!.getBoundingClientRect()

  expect(scroller.bottom - partlyVisible.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(3)
})
