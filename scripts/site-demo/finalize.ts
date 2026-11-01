import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const [input, data] = process.argv.slice(2)
if (!input || !data?.startsWith("/tmp/kk-")) {
  throw new Error("Usage: node scripts/site-demo/finalize.ts <recording.json> /tmp/kk-<name>")
}

const exported: unknown = JSON.parse(readFileSync(input, "utf8"))
const text = typeof exported === "string" ? exported : JSON.stringify(exported)
const home = "/Users/you/code"
const recording = JSON.parse(text.replaceAll(`/private${data}`, home).replaceAll(data, home), (key, value) =>
  key === "login" ? "you" : value,
)

const output = resolve(import.meta.dirname, "../../site/app/recording.json")
writeFileSync(output, `${JSON.stringify(recording)}\n`)
console.log(`Wrote ${recording.entries.length} entries to ${output}`)
