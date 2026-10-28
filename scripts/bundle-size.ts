#!/usr/bin/env node
import { readFileSync } from "node:fs"

type Check = { name: string; size: number; sizeLimit: number; passed: boolean }

const [basePath, headPath] = process.argv.slice(2)
if (!basePath || !headPath) {
  console.error("Usage: node scripts/bundle-size.ts <base.json> <head.json>")
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

const base = new Map(read(basePath).map((check) => [check.name, check.size]))
const rows = read(headPath).map(({ name, size, sizeLimit, passed }) => {
  const before = base.get(name)
  const budget = `${passed ? "✅" : "❌"} ${format(sizeLimit)}`
  return before === undefined
    ? `| ${name} | | ${format(size)} | new | ${budget} |`
    : `| ${name} | ${format(before)} | ${format(size)} | ${change(before, size)} | ${budget} |`
})

console.log(`### Bundle size

| | Base | This PR | Change | Budget |
| --- | --: | --: | --: | --: |
${rows.join("\n")}

Measured from a Linux build of both commits. Budgets live in \`.size-limit.json\`.`)
