import { describe, expect, test } from "vitest"
import { type ArtifactTheme, injectArtifactTheme, parseArtifactTheme, THEME_TOKENS } from "./artifactTheme.ts"

const tokens = Object.fromEntries(THEME_TOKENS.map((token) => [token, "oklch(0.5 0 0)"])) as ArtifactTheme["tokens"]
const theme: ArtifactTheme = { scheme: "dark", tokens: { ...tokens, "--border": "oklch(1 0 0 / 10%)" } }
const STYLE = '<style id="hinacode-theme">'

describe("injectArtifactTheme", () => {
  test("puts the theme inside head, after the doctype, or first", () => {
    expect(injectArtifactTheme("<!doctype html><html><head><title>A</title></head></html>", theme)).toMatch(
      /^<!doctype html><html><head><style id="hinacode-theme">.*<\/style><title>A<\/title>/,
    )
    expect(injectArtifactTheme("<!DOCTYPE html><title>A</title>", theme)).toMatch(
      /^<!DOCTYPE html><style id="hinacode-theme">.*<\/style><title>A<\/title>$/,
    )
    expect(injectArtifactTheme("<header>A</header>", theme)).toMatch(/^<style id="hinacode-theme">.*<\/style><header>A/)
  })

  test("writes the scheme and every token on :root", () => {
    const html = injectArtifactTheme("", theme)
    expect(html.startsWith(STYLE)).toBe(true)
    expect(html).toContain(":root{color-scheme:dark;")
    expect(html).toContain("--border:oklch(1 0 0 / 10%);")
  })
})

describe("parseArtifactTheme", () => {
  test("accepts a full theme", () => {
    expect(parseArtifactTheme(JSON.stringify(theme))).toEqual(theme)
  })

  test("refuses anything that could leave the style rule", () => {
    for (const border of ["red}</style><script>alert(1)</script>", "red;background:url(x)", 1]) {
      const json = JSON.stringify({ scheme: "light", tokens: { ...tokens, "--border": border } })
      expect(parseArtifactTheme(json), String(border)).toBeUndefined()
    }
    expect(parseArtifactTheme(JSON.stringify({ ...theme, scheme: "sepia" }))).toBeUndefined()
    expect(parseArtifactTheme("{")).toBeUndefined()
    expect(parseArtifactTheme(null)).toBeUndefined()
  })

  test("drops tokens it does not know", () => {
    const parsed = parseArtifactTheme(JSON.stringify({ ...theme, tokens: { ...theme.tokens, "--evil": "red" } }))
    expect(parsed?.tokens).not.toHaveProperty("--evil")
  })
})
