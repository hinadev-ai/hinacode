import { join } from "node:path"
import { lock } from "proper-lockfile"
import { openArtifactStore, type PublishInput } from "./store.ts"

const [mode, root, id] = process.argv.slice(2)
if (root === undefined || process.send === undefined) throw new Error("A store and an IPC channel are required.")

if (mode === "hold" && id !== undefined) {
  await lock(join(root, id), { realpath: false })
  process.send("ready")
  process.on("message", () => {})
} else if (mode === "publish") {
  const store = openArtifactStore(root)
  process.on("message", async (message: unknown) => {
    try {
      const artifact = await store.publish(message as PublishInput)
      process.send?.(artifact, () => process.disconnect())
    } catch (error) {
      process.send?.({ error: error instanceof Error ? error.message : String(error) }, () => process.disconnect())
    }
  })
  process.send("ready")
} else {
  throw new Error("Unknown store test process mode.")
}
