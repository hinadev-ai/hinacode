import { readFileSync } from "node:fs"

// index.html lists the entry and, as modulepreload links, every chunk it imports statically. A launch loads all of
// them, so splitting code into a preloaded chunk must not look like a win.
const html = readFileSync(new URL("out/renderer/index.html", import.meta.url), "utf8")
const startupScripts = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+\.js)"/g)].map(
  ([, path]) => `out/renderer/${path}`,
)
// Stylesheets a lazy chunk imports, such as the CJK fonts, are linked only once that chunk loads.
const startupStyles = [...html.matchAll(/href="\.\/(assets\/[^"]+\.css)"/g)].map(([, path]) => `out/renderer/${path}`)

// Budgets apply to the raw size, which is what Electron reads from disk. A check named "<name> (gzip)" shows the
// gzipped size of "<name>" next to it.
export default [
  { name: "Renderer startup JS", path: startupScripts, brotli: false, limit: "3.2 MB" },
  { name: "Renderer startup JS (gzip)", path: startupScripts, gzip: true },
  { name: "Renderer JS, all chunks", path: "out/renderer/assets/*.js", brotli: false, limit: "16 MB" },
  { name: "Renderer JS, all chunks (gzip)", path: "out/renderer/assets/*.js", gzip: true },
  { name: "Renderer startup CSS", path: startupStyles, brotli: false, limit: "250 kB" },
  { name: "Renderer startup CSS (gzip)", path: startupStyles, gzip: true },
  { name: "Renderer CSS, all", path: "out/renderer/assets/*.css", brotli: false, limit: "500 kB" },
  { name: "Main process JS", path: "out/main", brotli: false, limit: "2.3 MB" },
  { name: "Main process JS (gzip)", path: "out/main", gzip: true },
  { name: "app.asar", path: "dist/linux-unpacked/resources/app.asar", brotli: false, limit: "100 MB" },
  { name: "Linux app, installed", path: "dist/linux-unpacked", brotli: false, limit: "430 MB" },
  { name: "Linux AppImage download", path: "dist/*.AppImage", brotli: false, limit: "170 MB" },
]
