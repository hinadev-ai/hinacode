import en from "../../../../messages/en.json"

type Key = Extract<keyof typeof en, `mobile_${string}`>

/**
 * English copy from the repo's shared catalog. The phone is English only for now, so this reads `en.json`
 * directly instead of pulling in Paraglide.
 */
export const copy = (key: Key, params: Readonly<Record<string, string>> = {}) =>
  en[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => params[name] ?? placeholder)
