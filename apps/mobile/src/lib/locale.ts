export type CatalogLocale = "en" | "ja" | "zh-TW" | "zh-CN"

const traditionalChineseRegions = new Set(["tw", "hk", "mo"])

const chineseCatalog = (subtags: readonly string[]): CatalogLocale => {
  if (subtags.includes("hans")) return "zh-CN"
  return subtags.includes("hant") || subtags.some((subtag) => traditionalChineseRegions.has(subtag)) ? "zh-TW" : "zh-CN"
}

const catalogFor = (languageTag: string): CatalogLocale | null => {
  const [language, ...subtags] = languageTag.toLowerCase().split(/[-_]/)
  if (language === "en" || language === "ja") return language
  return language === "zh" ? chineseCatalog(subtags) : null
}

export const resolveCatalogLocale = (languageTags: readonly string[]): CatalogLocale => {
  for (const languageTag of languageTags) {
    const locale = catalogFor(languageTag)
    if (locale) return locale
  }
  return "en"
}
