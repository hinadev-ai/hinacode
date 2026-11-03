import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export default function globalSetup() {
  const root = mkdtempSync(join(tmpdir(), "hinacode-test-"))
  process.env.TMPDIR = root
  return () => rmSync(root, { recursive: true, force: true })
}
