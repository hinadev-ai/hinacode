#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { documentOfSize, documentSizes } from "./documents.ts"

const [cdp, threadId] = process.argv.slice(2)
if (!cdp || !threadId) {
  console.error("usage: seed-documents.ts <cdp-port> <thread-id>")
  process.exit(2)
}
const rpcScript = join(dirname(fileURLToPath(import.meta.url)), "../../.agents/skills/verify-hinacode/scripts/rpc.ts")
const rpc = (method: string, payload: unknown) =>
  JSON.parse(execFileSync("node", [rpcScript, cdp, method, JSON.stringify(payload)], { encoding: "utf8" }))

const ids = Object.entries(documentSizes).map(([size, bytes]) => {
  const artifact = rpc("artifacts.createDocument", { threadId, title: `perf ${size}` })
  const { revision } = rpc("artifacts.readDocument", { id: artifact.id })
  const saved = rpc("artifacts.saveDocument", {
    id: artifact.id,
    baseRevision: revision,
    markdown: documentOfSize(bytes),
  })
  if (saved.type !== "saved") throw new Error(`saving the ${size} document hit a conflict`)
  return `${size}:${artifact.id}`
})
console.log(`PERF_DOC_THREAD=${threadId} PERF_DOCS=${ids.join(",")}`)
