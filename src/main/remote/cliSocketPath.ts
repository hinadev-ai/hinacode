import { createHash } from "node:crypto"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

const MAX_SOCKET_PATH_BYTES = 103

export const cliSocketPath = (dataDir: string, runtimeDir = join(tmpdir(), `hinacode-${userInfo().uid}`)) => {
  const beside = join(dataDir, "run", "cli.sock")
  if (Buffer.byteLength(beside) <= MAX_SOCKET_PATH_BYTES) return beside
  return join(runtimeDir, `${createHash("sha256").update(dataDir).digest("hex").slice(0, 16)}.sock`)
}
