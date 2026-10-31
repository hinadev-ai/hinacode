import en from "../../../../messages/en.json"

type Key = Extract<keyof typeof en, `mobile_${string}`>

export const copy = (key: Key, params: Readonly<Record<string, string>> = {}) =>
  en[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => params[name] ?? placeholder)
