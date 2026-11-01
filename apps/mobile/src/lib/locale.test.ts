import { describe, expect, it } from "vitest"
import { resolveCatalogLocale } from "./locale"

describe("resolveCatalogLocale", () => {
  it("reads Japanese", () => {
    expect(resolveCatalogLocale(["ja-JP"])).toBe("ja")
    expect(resolveCatalogLocale(["ja"])).toBe("ja")
  })

  it("reads every Traditional Chinese tag as zh-TW", () => {
    for (const tag of ["zh-TW", "zh-Hant", "zh-Hant-TW", "zh-HK", "zh_Hant_HK", "zh-MO"]) {
      expect(resolveCatalogLocale([tag])).toBe("zh-TW")
    }
  })

  it("reads Simplified and bare Chinese tags as zh-CN", () => {
    for (const tag of ["zh-CN", "zh-Hans", "zh-Hans-CN", "zh-Hans-HK", "zh_Hans_SG", "zh-SG", "zh"]) {
      expect(resolveCatalogLocale([tag])).toBe("zh-CN")
    }
  })

  it("takes the first preferred language it has a catalog for", () => {
    expect(resolveCatalogLocale(["fr-FR", "ja-JP", "zh-TW"])).toBe("ja")
    expect(resolveCatalogLocale(["en-GB", "ja-JP"])).toBe("en")
  })

  it("falls back to English", () => {
    expect(resolveCatalogLocale(["de-DE"])).toBe("en")
    expect(resolveCatalogLocale([])).toBe("en")
  })
})
