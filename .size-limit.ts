import { readFileSync } from "node:fs"

// index.html lists the entry and, as modulepreload links, every chunk it imports statically. A launch loads all of
// them, so splitting code into a preloaded chunk must not look like a win.
const startupScripts = [
  ...readFileSync(new URL("out/renderer/index.html", import.meta.url), "utf8").matchAll(
    /(?:src|href)="\.\/(assets\/[^"]+\.js)"/g,
  ),
].map(([, path]) => `out/renderer/${path}`)

// Budgets apply to the raw size, which is what Electron reads from disk. A check named "<name> (gzip)" shows the
// gzipped size of "<name>" next to it.
export default [
  { name: "Renderer startup JS", path: startupScripts, brotli: false, limit: "9.5 MB" },
  { name: "Renderer startup JS (gzip)", path: startupScripts, gzip: true },
  { name: "Renderer JS, all chunks", path: "out/renderer/assets/*.js", brotli: false, limit: "22 MB" },
  { name: "Renderer JS, all chunks (gzip)", path: "out/renderer/assets/*.js", gzip: true },
  { name: "Renderer CSS", path: "out/renderer/assets/*.css", brotli: false, limit: "500 kB" },
  { name: "Renderer CSS (gzip)", path: "out/renderer/assets/*.css", gzip: true },
  { name: "Main process JS", path: "out/main", brotli: false, limit: "2.3 MB" },
  { name: "Main process JS (gzip)", path: "out/main", gzip: true },
  { name: "app.asar", path: "dist/linux-unpacked/resources/app.asar", brotli: false, limit: "100 MB" },
  { name: "Linux app, installed", path: "dist/linux-unpacked", brotli: false, limit: "430 MB" },
  { name: "Linux AppImage download", path: "dist/*.AppImage", brotli: false, limit: "170 MB" },
]
