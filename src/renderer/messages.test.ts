import { describe, expect, test } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { Locale } from "../shared/domain.ts"

const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../messages/${locale}.json`, import.meta.url), "utf8"))

const placeholders = (message: unknown) => [...new Set(JSON.stringify(message).match(/\{\w+\}/g))].toSorted()

const base = catalog("en")

describe.each(Locale.literals.filter((locale) => locale !== "en"))("messages/%s.json", (locale) => {
  const messages = catalog(locale)

  test("has every English key and no others", () => {
    expect(Object.keys(messages).toSorted()).toEqual(Object.keys(base).toSorted())
  })

  test("keeps every placeholder of the English message", () => {
    const mismatched = Object.keys(base).filter(
      (key) => placeholders(messages[key]).join() !== placeholders(base[key]).join(),
    )
    expect(mismatched).toEqual([])
  })
})
