import { resolve } from "node:path"
import { type CompilerOptions, paraglideVitePlugin } from "@inlang/paraglide-js"
import type { Plugin } from "vite"

const outdir = resolve(import.meta.dirname, "src/renderer/paraglide")
const messageIndex = resolve(outdir, "messages/_index.js")
const localeCatalogs = resolve(import.meta.dirname, "src/renderer/lib/localeCatalogs.ts")

export const paraglideOptions = {
  project: resolve(import.meta.dirname, "project.inlang"),
  outdir,
  strategy: ["globalVariable", "baseLocale"],
  outputStructure: "locale-modules",
} satisfies CompilerOptions

export const paraglide = () => (process.env["HINACODE_PARAGLIDE_COMPILED"] ? [] : paraglideVitePlugin(paraglideOptions))

const localeImport = /^import \* as __(?!en\b)\w+ from "\.\/[\w-]+\.js"\n/gm
const dispatch =
  /\(\(inputs(?: = \{\})?, options = \{\}\) => \{\n\tconst locale = experimentalStaticLocale \?\? options\.locale \?\? getLocale\(\)\n(?:\tif \(locale === "[\w-]+"\) return __\w+\.\w+\(inputs\)\n)*\treturn __en\.(\w+)\(inputs\)\n\}\)/g

export const lazyLocales = (): Plugin => ({
  name: "hinacode:lazy-locales",
  enforce: "post",
  transform(code, id) {
    if (id !== messageIndex) return
    const lazy = code.replace(localeImport, "").replace(dispatch, '(localized("$1", __en.$1))')
    if (/getLocale\(\)\n|^import \* as __(?!en\b)/m.test(lazy))
      throw new Error(`${messageIndex} has a shape lazyLocales does not know. Update vite.paraglide.ts.`)
    return `import { localized } from ${JSON.stringify(localeCatalogs)}\n${lazy}`
  },
})
