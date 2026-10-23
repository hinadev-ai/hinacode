// Usage: fatfill.ts <dir> <files>  Writes <files> small files in a pnpm-like nested layout under <dir>/node_modules.
import { mkdirSync, writeFileSync } from "node:fs"
const [dir, count] = process.argv.slice(2)
const n = Number(count)
let written = 0
for (let p = 0; written < n; p++) {
  const pkg = `${dir}/node_modules/.pnpm/pkg-${p}@1.0.0/node_modules/pkg-${p}`
  for (const sub of ["dist", "dist/esm", "src", "lib/internal"]) mkdirSync(`${pkg}/${sub}`, { recursive: true })
  for (let f = 0; f < 50 && written < n; f++, written++) {
    const sub = ["dist", "dist/esm", "src", "lib/internal"][f % 4]
    writeFileSync(`${pkg}/${sub}/file-${f}.js`, "export const x = " + f + ";\n".repeat(20))
  }
}
console.log("files", written)
