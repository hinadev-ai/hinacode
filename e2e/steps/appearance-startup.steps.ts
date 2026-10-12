import { expect } from "@playwright/test"
import { Given, Then } from "../support/fixtures.ts"

Given("the saved neutral appearance is {string}", ({ seed }, theme: string) => {
  if (theme !== "light" && theme !== "default") throw new Error(`Unknown neutral appearance ${theme}`)
  seed.setting("appearance", { theme, fontSize: 16, uiFont: null, monoFont: null })
})

const expectedAppearance = (scheme: string) => {
  if (scheme !== "light" && scheme !== "dark") throw new Error(`Unknown appearance ${scheme}`)
  return { scheme, rendered: true, background: scheme === "light" ? "oklch(1 0 0)" : "oklch(0.145 0 0)" }
}

Then("the first visible window uses the {string} appearance", ({ app }, scheme: string) => {
  expect(app.firstVisible).toEqual(expectedAppearance(scheme))
})

Then("the first contentful paint uses the {string} appearance", ({ app }, scheme: string) => {
  expect(app.firstPaint).toEqual(expectedAppearance(scheme))
})
