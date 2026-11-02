import en from "../../messages/en.json"
import zhTW from "../../messages/zh-TW.json"
import ja from "../../messages/ja.json"
import { fill } from "./fill.ts"

export type Locale = "en" | "zh-TW" | "ja"
export type Page = "home" | "pricing"
type StringKeys<T> = { [K in keyof T]: T[K] extends string ? K : never }[keyof T]
export type StringKey = StringKeys<typeof en> & StringKeys<typeof zhTW> & StringKeys<typeof ja>

export const locales: readonly Locale[] = ["en", "zh-TW", "ja"]
export const localePaths: Record<Locale, string> = { en: "", "zh-TW": "zh-tw", ja: "ja" }
export const languageNames: Record<Locale, string> = {
  en: en.locale_en,
  "zh-TW": en.locale_zh_tw,
  ja: en.locale_ja,
}

const catalogs: Record<Locale, Record<StringKey, string>> = { en, "zh-TW": zhTW, ja }

export function translator(locale: Locale) {
  return (key: StringKey, values: Record<string, string | number> = {}) => fill(catalogs[locale][key], values)
}

export function pick<const K extends StringKey>(locale: Locale, keys: readonly K[]): Record<K, string> {
  return Object.fromEntries(keys.map((key) => [key, catalogs[locale][key]])) as Record<K, string>
}

export function localizedPath(locale: Locale, page: Page): string {
  const prefix = locale === "en" ? "" : `/${localePaths[locale]}`
  return `${prefix}/${page === "pricing" ? "pricing/" : ""}`
}

export function localeFromParam(param: string | undefined): Locale {
  return locales.find((locale) => localePaths[locale] === param) ?? "en"
}
