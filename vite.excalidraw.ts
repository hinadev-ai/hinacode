import type { Plugin } from "vite"
import { viteStaticCopy } from "vite-plugin-static-copy"

const dist = "node_modules/@excalidraw/excalidraw/dist/prod"
const shippedLocales = /\/locales\/(zh-TW|zh-CN|ja-JP)-\w+\.js$/
const unusedFeature = "\0excalidraw-unused"

const fonts = () =>
  viteStaticCopy({
    targets: [
      {
        src: `../../${dist}/fonts/!(Xiaolai)`,
        dest: "excalidraw",
        rename: { stripBase: dist.split("/").length },
      },
    ],
  })

const dropUnusedFeatures = (): Plugin => ({
  name: "hinacode:excalidraw-unused",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer?.includes("/@excalidraw/excalidraw/")) return
    if (source === "@excalidraw/mermaid-to-excalidraw") return unusedFeature
    if (/^\.\/subset-(shared|worker)\.chunk\.js$/.test(source)) return unusedFeature
    if (source.startsWith("./locales/") && !shippedLocales.test(source)) return unusedFeature
  },
  load(id) {
    if (id === unusedFeature) return "export default {}"
  },
})

export const excalidraw = () => [fonts(), dropUnusedFeatures()]
