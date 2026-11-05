import { expect, test } from "vitest"
import { render } from "vitest-browser-react"
import "../index.css"
import { ShimmerText } from "./ShimmerText.tsx"

test("sweeps a band over its own glyphs, sized to the text", async () => {
  const { container } = await render(
    <div style={{ display: "flex", flexDirection: "column", width: 600, alignItems: "stretch" }}>
      <ShimmerText text="Thinking" />
    </div>,
  )
  const text = container.querySelector("p")
  if (text === null) throw new Error("no text rendered")
  const band = getComputedStyle(text, "::before")

  expect(text.getBoundingClientRect().width).toBeLessThan(200)
  expect(band.content).toContain("Thinking")
  expect(band.backgroundClip).toBe("text")
  expect(band.color).toBe("rgba(0, 0, 0, 0)")
  expect(band.animationName).toBe("text-shimmer")
})
