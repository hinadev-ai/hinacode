import type { Locale } from "../../shared/domain.ts"
import { getLocale } from "../paraglide/runtime.js"

type Message = (inputs: unknown) => string
type Catalog = Readonly<Record<string, Message | undefined>>

const loaders = import.meta.glob<Catalog>(["../paraglide/messages/*.js", "!**/_index.js", "!**/en.js"])
const catalogs = new Map<string, Catalog>()

export async function loadLocale(locale: Locale) {
  const load = loaders[`../paraglide/messages/${locale}.js`]
  if (load && !catalogs.has(locale)) catalogs.set(locale, await load())
}

export const localized =
  (key: string, english: Message) =>
  (inputs: unknown = {}, options: { readonly locale?: string } = {}) =>
    (catalogs.get(options.locale ?? getLocale())?.[key] ?? english)(inputs)
