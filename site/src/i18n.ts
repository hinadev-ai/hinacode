import en from "../../messages/en.json"
import zhTW from "../../messages/zh-TW.json"
import ja from "../../messages/ja.json"

export type Locale = "en" | "zh-TW" | "ja"
export type Page = "home" | "pricing"
export type SiteMessages = Pick<typeof en, Extract<keyof typeof en, `site_${string}`>>

export const locales: readonly Locale[] = ["en", "zh-TW", "ja"]
export const localePaths: Record<Locale, string> = { en: "", "zh-TW": "zh-tw", ja: "ja" }
export const languageNames: Record<Locale, string> = {
  en: en.locale_en,
  "zh-TW": en.locale_zh_tw,
  ja: en.locale_ja,
}

const catalogs = { en, "zh-TW": zhTW, ja } satisfies Record<Locale, SiteMessages>

export function messages(locale: Locale): SiteMessages {
  return catalogs[locale]
}

export function localizedPath(locale: Locale, page: Page): string {
  const prefix = locale === "en" ? "" : `/${localePaths[locale]}`
  return `${prefix}/${page === "pricing" ? "pricing/" : ""}`
}
