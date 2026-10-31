import en from "../../../../messages/en.json"
import ja from "../../../../messages/ja.json"
import zhTW from "../../../../messages/zh-TW.json"
import { deviceLanguageTags } from "./device-locale"
import { type CatalogLocale, resolveCatalogLocale } from "./locale"

type Key = Extract<keyof typeof en, `mobile_${string}`>

const catalogs: Record<CatalogLocale, Record<Key, string>> = { en, ja, "zh-TW": zhTW }

const catalog = catalogs[resolveCatalogLocale(deviceLanguageTags())]

export const copy = (key: Key, params: Readonly<Record<string, string>> = {}) =>
  catalog[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => params[name] ?? placeholder)
