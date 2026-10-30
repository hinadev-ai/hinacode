#!/usr/bin/env node
import { readFileSync } from "node:fs"

type Check = { name: string; size: number; sizeLimit?: number; passed?: boolean }

const [basePath, headPath, baseSha, headSha] = process.argv.slice(2)
if (!basePath || !headPath || !baseSha || !headSha) {
  console.error("Usage: node scripts/bundle-size.ts <base.json> <head.json> <base-sha> <head-sha>")
  process.exit(1)
}

const read = (path: string): Check[] => {
  const json: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!Array.isArray(json)) throw new Error(`${path} is not size-limit --json output: ${JSON.stringify(json)}`)
  return json
}

const format = (bytes: number) => {
  const units = ["B", "kB", "MB", "GB"]
  const power = Math.min(Math.floor(Math.log10(Math.max(Math.abs(bytes), 1)) / 3), units.length - 1)
  return `${Number((bytes / 1000 ** power).toFixed(2))} ${units[power]}`
}

const change = (before: number, after: number) => {
  const diff = after - before
  if (diff === 0) return "0"
  const sign = diff > 0 ? "+" : "-"
  return `${sign}${format(Math.abs(diff))} (${sign}${((Math.abs(diff) / before) * 100).toFixed(1)}%)`
}

const GZIP = " (gzip)"
const base = new Map(read(basePath).map((check) => [check.name, check.size]))
const head = read(headPath)
const headSizes = new Map(head.map((check) => [check.name, check.size]))

const compare = (name: string, after: number) => {
  const before = base.get(name)
  return before === undefined ? ["", format(after), "new"] : [format(before), format(after), change(before, after)]
}

const rows = head
  .filter((check) => !check.name.endsWith(GZIP))
  .map(({ name, size, sizeLimit, passed }) => {
    const gzip = headSizes.get(name + GZIP)
    const [, gzipSize, gzipChange] = gzip === undefined ? [] : compare(name + GZIP, gzip)
    const budget = sizeLimit === undefined ? "" : `${passed ? "✅" : "❌"} ${format(sizeLimit)}`
    return `| ${[name, ...compare(name, size), gzipSize ?? "", gzipChange ?? "", budget].join(" | ")} |`
  })

console.log(`<!-- bundle-size -->
### Bundle size

| | Base | This PR | Change | Gzipped | Gzip change | Budget |
| --- | --: | --: | --: | --: | --: | --: |
${rows.join("\n")}

Measured from Linux builds of ${baseSha.slice(0, 7)} (base) and ${headSha.slice(0, 7)} (this PR). Budgets apply to the raw size and live in \`.size-limit.ts\`.`)
