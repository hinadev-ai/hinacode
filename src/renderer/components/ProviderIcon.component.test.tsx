import { expect, test } from "vitest"
import { render } from "vitest-browser-react"
import "../index.css"
import { ThreadProviderIcon } from "./ProviderIcon.tsx"

test("shows the vendor mark beside magpie when it knows the model", async () => {
  const { container } = await render(<ThreadProviderIcon provider="magpie" model="moonshot/kimi-k3" />)
  const marks = container.querySelectorAll("svg")

  expect(marks).toHaveLength(2)
})

test("gives the vendor mark its brand color", async () => {
  const { container } = await render(<ThreadProviderIcon provider="magpie" model="openrouter/deepseek-v4" />)
  const [magpie, deepseek] = container.querySelectorAll("svg")

  expect(getComputedStyle(deepseek!).color).not.toBe(getComputedStyle(magpie!).color)
})

test("shows only magpie when it does not know the model", async () => {
  const { container } = await render(<ThreadProviderIcon provider="magpie" model="group/daily" />)

  expect(container.querySelectorAll("svg")).toHaveLength(1)
})

test("leaves other agents with one mark", async () => {
  const { container } = await render(<ThreadProviderIcon provider="claude" model="openrouter/moonshotai/kimi-k3" />)

  expect(container.querySelectorAll("svg")).toHaveLength(1)
})
