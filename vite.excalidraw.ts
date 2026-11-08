import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { Plugin } from "vite"

const FAMILIES = ["Excalifont", "Nunito", "ComicShanns", "Lilita", "Virgil", "Cascadia", "Liberation"]
const FONT_PATH = /^\/([A-Za-z]+)\/([\w.-]+\.woff2)$/

const fontsDirectory = join(dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")), "fonts")

const fontFiles = () =>
  FAMILIES.flatMap((family) => readdirSync(join(fontsDirectory, family)).map((file) => `${family}/${file}`))

export const excalidrawFonts = (): Plugin => ({
  name: "hinacode-excalidraw-fonts",
  configureServer(server) {
    const base = server.config.base.startsWith("/") ? server.config.base : "/"
    server.middlewares.use(`${base}excalidraw/fonts`, (request, response, next) => {
      const match = FONT_PATH.exec(decodeURIComponent(request.url?.split("?")[0] ?? ""))
      const path = match === null ? "" : join(fontsDirectory, match[1] ?? "", match[2] ?? "")
      if (match === null || !FAMILIES.includes(match[1] ?? "") || !existsSync(path)) return next()
      response.setHeader("Content-Type", "font/woff2")
      response.end(readFileSync(path))
    })
  },
  generateBundle() {
    for (const file of fontFiles()) {
      this.emitFile({
        type: "asset",
        fileName: `excalidraw/fonts/${file}`,
        source: readFileSync(join(fontsDirectory, file)),
      })
    }
  },
})
