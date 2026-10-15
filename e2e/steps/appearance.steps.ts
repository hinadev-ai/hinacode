import { expect } from "@playwright/test"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

// Saved before contrast existed, so it reads back with the default contrast.
const existingAppearance = { theme: "catppuccin-latte", fontSize: 18, uiFont: "sans-serif", monoFont: "monospace" }

Given("an existing named theme and font preference", ({ seed }) => {
  seed.setting("appearance", existingAppearance)
})

When("I open appearance settings", async ({ app }) => {
  await app.page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Appearance" })
    .click()
})

When("I choose the theme {string}", async ({ app }, theme: string) => {
  await app.page.getByText(theme, { exact: true }).click()
  await expect(app.page.getByRole("radio", { name: theme, exact: true })).toBeChecked()
})

When("the system appearance changes to {string}", async ({ app }, scheme: string) => {
  if (scheme !== "dark" && scheme !== "light") throw new Error(`Unknown appearance ${scheme}`)
  await app.page.emulateMedia({ colorScheme: scheme })
})

Then("the app uses the {string} appearance", async ({ app }, scheme: string) => {
  await expect
    .poll(() => app.page.evaluate(() => (document.documentElement.classList.contains("dark") ? "dark" : "light")))
    .toBe(scheme)
})

Then("the theme {string} is saved", async ({ app }, theme: string) => {
  await expect.poll(async () => (await rpc(app.page, "settings.get", undefined)).appearance.theme).toBe(theme)
})

Then("the existing named theme and font preference is preserved", async ({ app }) => {
  expect((await rpc(app.page, "settings.get", undefined)).appearance).toEqual({ ...existingAppearance, contrast: 0 })
  await expect(app.page.locator("html")).toHaveAttribute("data-theme", "catppuccin-latte")
  await expect(app.page.locator("html")).toHaveCSS("font-size", "18px")
})

const sliderKeys: Record<string, string | null> = { Lowest: "Home", Standard: null, Highest: "End" }

When("I move the contrast slider to {string}", async ({ app }, position: string) => {
  const key = sliderKeys[position]
  if (key === undefined) throw new Error(`Unknown contrast position ${position}`)
  if (key !== null) await app.page.getByRole("slider", { name: "Contrast" }).press(key)
})

Then("the contrast {int} is saved", async ({ app }, contrast: number) => {
  await expect.poll(async () => (await rpc(app.page, "settings.get", undefined)).appearance.contrast).toBe(contrast)
})

Then("text reads at higher contrast than the palette", async ({ app }) => {
  const [text, palette, mutedText, mutedPalette] = await app.page.evaluate(contrastRatios, [
    ["foreground", "background"],
    ["palette-foreground", "background"],
    ["muted-foreground", "background"],
    ["palette-muted-foreground", "background"],
  ])
  expect(text).toBeGreaterThan(palette ?? Infinity)
  expect(mutedText).toBeGreaterThan(mutedPalette ?? Infinity)
})

Then("text and keyboard focus meet contrast requirements", async ({ app }) => {
  await app.page.getByLabel("Font size", { exact: true }).focus()
  await app.page.keyboard.press("Shift+Tab")
  await app.page.keyboard.press("Tab")
  const focused = await app.page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false)
  expect(focused, "Keyboard focus indicator is missing").toBe(true)
  const surfaces = ["background", "muted", "sidebar", "popover"]
  const ratios = await app.page.evaluate(
    contrastRatios,
    surfaces.flatMap((surface) => [
      ["foreground", surface],
      ["muted-foreground", surface],
      ["focus-ring", surface],
    ]),
  )
  surfaces.forEach((surface, index) => {
    expect(ratios[index * 3], `Text on ${surface}`).toBeGreaterThanOrEqual(4.5)
    expect(ratios[index * 3 + 1], `Muted text on ${surface}`).toBeGreaterThanOrEqual(4.5)
    expect(ratios[index * 3 + 2], `Focus on ${surface}`).toBeGreaterThanOrEqual(3)
  })
})

/**
 * WCAG contrast of each [foreground, background] pair of root custom properties, flattened through a canvas so
 * translucent and color-mix tokens resolve the way they render. "focus-ring" reads the focused element's ring.
 * Runs in the page, so it cannot use anything from this module.
 */
function contrastRatios(pairs: ReadonlyArray<ReadonlyArray<string>>): number[] {
  const context = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })
  if (!context) throw new Error("Canvas is unavailable")
  const style = getComputedStyle(document.documentElement)
  const color = (name: string) => {
    if (name !== "focus-ring") return style.getPropertyValue(`--${name}`)
    const focused = document.activeElement
    const ring = focused ? getComputedStyle(focused).getPropertyValue("--tw-ring-color") : ""
    if (!ring) throw new Error("Focus ring is missing")
    return ring
  }
  const luminance = (foreground: string, background: string) => {
    context.fillStyle = background
    context.fillRect(0, 0, 1, 1)
    context.fillStyle = foreground
    context.fillRect(0, 0, 1, 1)
    const [red = 0, green = 0, blue = 0] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return red * 0.2126 + green * 0.7152 + blue * 0.0722
  }
  return pairs.map(([foreground = "", background = ""]) => {
    const a = luminance(color(foreground), color(background))
    const b = luminance(color(background), color(background))
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })
}
