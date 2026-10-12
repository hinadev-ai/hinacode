import { expect } from "@playwright/test"
import { Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

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
  expect((await rpc(app.page, "settings.get", undefined)).appearance).toEqual(existingAppearance)
  await expect(app.page.locator("html")).toHaveAttribute("data-theme", "catppuccin-latte")
  await expect(app.page.locator("html")).toHaveCSS("font-size", "18px")
})

Then("text and keyboard focus meet contrast requirements", async ({ app }) => {
  await app.page.getByLabel("Font size", { exact: true }).focus()
  await app.page.keyboard.press("Shift+Tab")
  await app.page.keyboard.press("Tab")
  const measurements = await app.page.evaluate(() => {
    const focused = document.activeElement
    if (!focused?.matches(":focus-visible")) throw new Error("Keyboard focus indicator is missing")
    const context = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })
    if (!context) throw new Error("Canvas is unavailable")
    const luminance = (color: string, background: string) => {
      context.fillStyle = background
      context.fillRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      const [red = 0, green = 0, blue = 0] = channels
      return red * 0.2126 + green * 0.7152 + blue * 0.0722
    }
    const ratio = (foreground: string, background: string) => {
      const a = luminance(foreground, background)
      const b = luminance(background, background)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    const style = getComputedStyle(document.documentElement)
    const token = (name: string) => style.getPropertyValue(`--${name}`)
    const ring = getComputedStyle(focused).getPropertyValue("--tw-ring-color")
    if (!ring) throw new Error("Focus ring is missing")
    return ["background", "muted", "sidebar", "popover"].map((surface) => ({
      surface,
      text: ratio(token("foreground"), token(surface)),
      mutedText: ratio(token("muted-foreground"), token(surface)),
      focus: ratio(ring, token(surface)),
    }))
  })
  for (const measurement of measurements) {
    expect(measurement.text, `Text on ${measurement.surface}`).toBeGreaterThanOrEqual(4.5)
    expect(measurement.mutedText, `Muted text on ${measurement.surface}`).toBeGreaterThanOrEqual(4.5)
    expect(measurement.focus, `Focus on ${measurement.surface}`).toBeGreaterThanOrEqual(3)
  }
})
