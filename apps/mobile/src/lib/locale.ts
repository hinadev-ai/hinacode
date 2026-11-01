export type CatalogLocale = "en" | "ja" | "zh-TW"

const traditionalChineseRegions = new Set(["tw", "hk", "mo"])

const catalogFor = (languageTag: string): CatalogLocale | null => {
  const [language, ...subtags] = languageTag.toLowerCase().split(/[-_]/)
  if (language === "en" || language === "ja") return language
  if (language !== "zh" || subtags.includes("hans")) return null
  return subtags.includes("hant") || subtags.some((subtag) => traditionalChineseRegions.has(subtag)) ? "zh-TW" : null
}

export const resolveCatalogLocale = (languageTags: readonly string[]): CatalogLocale => {
  for (const languageTag of languageTags) {
    const locale = catalogFor(languageTag)
    if (locale) return locale
  }
  return "en"
}
