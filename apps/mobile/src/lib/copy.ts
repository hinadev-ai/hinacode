import en from "../../../../messages/en.json"
import ja from "../../../../messages/ja.json"
import zhCN from "../../../../messages/zh-CN.json"
import zhTW from "../../../../messages/zh-TW.json"
import { deviceLanguageTags } from "./device-locale"
import { type CatalogLocale, resolveCatalogLocale } from "./locale"

/** The phone reads its own keys, plus the desktop's labels for HinaCode's MCP tools and its access mode copy. */
type Key = Extract<keyof typeof en, `mobile_${string}` | `tool_own_${string}` | `access_${string}`>

const catalogs: Record<CatalogLocale, Record<Key, string>> = { en, ja, "zh-TW": zhTW, "zh-CN": zhCN }

export const locale = resolveCatalogLocale(deviceLanguageTags())

const catalog = catalogs[locale]

export const copy = (key: Key, params: Readonly<Record<string, string>> = {}) =>
  catalog[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => params[name] ?? placeholder)
