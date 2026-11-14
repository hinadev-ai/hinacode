import { describe, expect, test } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { Locale } from "../shared/domain.ts"

const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../messages/${locale}.json`, import.meta.url), "utf8"))

const placeholders = (message: unknown) => [...new Set(JSON.stringify(message).match(/\{\w+\}/g))].toSorted()

const base = catalog("en")

test.each(Locale.literals)("messages/%s.json leaves the # or ! before a number to the code host", (locale) => {
  const messages = catalog(locale)
  expect(Object.keys(messages).filter((key) => JSON.stringify(messages[key]).includes("#{"))).toEqual([])
})

test.each(Locale.literals)("messages/%s.json leaves the phone app's code host name to {host}", (locale) => {
  const messages = catalog(locale)
  const namingHost = Object.keys(messages).filter(
    (key) => key.startsWith("mobile_pr_") && /GitHub|GitLab/.test(JSON.stringify(messages[key])),
  )
  expect(namingHost).toEqual(["mobile_pr_code_too_large"])
})

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
