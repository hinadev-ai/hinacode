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

  it("skips Simplified Chinese", () => {
    expect(resolveCatalogLocale(["zh-CN"])).toBe("en")
    expect(resolveCatalogLocale(["zh-Hans-HK"])).toBe("en")
    expect(resolveCatalogLocale(["zh"])).toBe("en")
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
