/**
 * Writes the iOS app's String Catalog from the `mobile_` keys of `messages/*.json`, so the three catalogs stay the
 * only place copy lives. Run `node scripts/ios-strings.ts` after changing a `mobile_` key, and commit the result.
 * `--check` fails when the committed catalog is stale.
 *
 * `{name}` placeholders become positional `%1$@` specifiers numbered by their order in English, so a translation
 * may move them. Xcode turns each key into a `LocalizedStringResource` symbol, such as `.mobileHomeTitle` or
 * `.mobileTerminalReattachFailed(message)`.
 */
import { readFileSync, writeFileSync } from "node:fs"

const OUTPUT = new URL("../apps/ios/HinaCode/Localizable.xcstrings", import.meta.url)

/** Catalog file and the iOS language it fills. */
const languages = [
  ["en", "en"],
  ["ja", "ja"],
  ["zh-TW", "zh-Hant"],
] as const

const catalogs = Object.fromEntries(
  languages.map(([file]) => [
    file,
    JSON.parse(readFileSync(new URL(`../messages/${file}.json`, import.meta.url), "utf8")) as Record<string, string>,
  ]),
)

const placeholders = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!))]

const format = (text: string, order: readonly string[]) =>
  text.replaceAll("%", "%%").replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const index = order.indexOf(name)
    if (index === -1) throw new Error(`${placeholder} is not in the English text`)
    return `%${index + 1}$@`
  })

const english = catalogs.en!
const strings = Object.fromEntries(
  Object.keys(english)
    .filter((key) => key.startsWith("mobile_"))
    .toSorted()
    .map((key) => {
      const order = placeholders(english[key]!)
      const localizations = Object.fromEntries(
        languages.flatMap(([file, language]) => {
          const text = catalogs[file]![key]
          return text === undefined
            ? []
            : [[language, { stringUnit: { state: "translated", value: format(text, order) } }]]
        }),
      )
      return [key, { extractionState: "manual", localizations }]
    }),
)

/** Xcode's own layout of a catalog, so opening the project in Xcode leaves the file unchanged. */
const xcode = (value: unknown, depth = 0): string => {
  const pad = "  ".repeat(depth + 1)
  const end = "  ".repeat(depth)
  if (typeof value !== "object" || value === null) return JSON.stringify(value)
  const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (entries.length === 0) return "{\n\n}"
  return `{\n${entries.map(([key, inner]) => `${pad}${JSON.stringify(key)} : ${xcode(inner, depth + 1)}`).join(",\n")}\n${end}}`
}

const source = `${xcode({ sourceLanguage: "en", strings, version: "1.0" })}\n`

if (process.argv.includes("--check")) {
  if (readFileSync(OUTPUT, "utf8") !== source) {
    console.error("apps/ios String Catalog is stale. Run `node scripts/ios-strings.ts` and commit the result.")
    process.exit(1)
  }
} else writeFileSync(OUTPUT, source)
