import { readFileSync } from "node:fs"

const html = readFileSync(new URL("out/renderer/index.html", import.meta.url), "utf8")
const startupScripts = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+\.js)"/g)].map(
  ([, path]) => `out/renderer/${path}`,
)
const startupStyles = [...html.matchAll(/href="\.\/(assets\/[^"]+\.css)"/g)].map(([, path]) => `out/renderer/${path}`)

export const warnings: Record<string, string> = {
  "Renderer startup JS": "2.13 MB",
  "Renderer JS, all chunks": "16.1 MB",
}

export default [
  { name: "Renderer startup JS", path: startupScripts, brotli: false },
  { name: "Renderer startup JS (gzip)", path: startupScripts, gzip: true },
  { name: "Renderer JS, all chunks", path: "out/renderer/assets/*.js", brotli: false },
  { name: "Renderer JS, all chunks (gzip)", path: "out/renderer/assets/*.js", gzip: true },
  { name: "Renderer startup CSS", path: startupStyles, brotli: false, limit: "205 kB" },
  { name: "Renderer startup CSS (gzip)", path: startupStyles, gzip: true },
  { name: "Renderer CSS, all", path: "out/renderer/assets/*.css", brotli: false, limit: "525 kB" },
  { name: "Main process JS", path: "out/main", brotli: false, limit: "2.7 MB" },
  { name: "Main process JS (gzip)", path: "out/main", gzip: true },
  { name: "app.asar", path: "dist/linux-unpacked/resources/app.asar", brotli: false, limit: "100 MB" },
  { name: "Linux app, installed", path: "dist/linux-unpacked", brotli: false, limit: "430 MB" },
  { name: "Linux AppImage download", path: "dist/*.AppImage", brotli: false, limit: "170 MB" },
]
