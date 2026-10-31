import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { Data, Effect } from "effect"

export const CLOUDFLARED_VERSION = "2026.10.3"

export interface CloudflaredAsset {
  readonly url: string
  readonly sha256: string
  readonly archive: "tgz" | "binary"
}

const RELEASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`

const ASSETS: Partial<Record<`${NodeJS.Platform}-${NodeJS.Architecture}`, CloudflaredAsset>> = {
  "darwin-arm64": {
    url: `${RELEASE}/cloudflared-darwin-arm64.tgz`,
    sha256: "1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55",
    archive: "tgz",
  },
  "darwin-x64": {
    url: `${RELEASE}/cloudflared-darwin-amd64.tgz`,
    sha256: "81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000",
    archive: "tgz",
  },
  "linux-arm64": {
    url: `${RELEASE}/cloudflared-linux-arm64`,
    sha256: "89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8",
    archive: "binary",
  },
  "linux-x64": {
    url: `${RELEASE}/cloudflared-linux-amd64`,
    sha256: "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
    archive: "binary",
  },
  "win32-x64": {
    url: `${RELEASE}/cloudflared-windows-amd64.exe`,
    sha256: "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2",
    archive: "binary",
  },
}

export const platformAsset = (): CloudflaredAsset | undefined => ASSETS[`${process.platform}-${process.arch}`]

export class CloudflaredInstallError extends Data.TaggedError("CloudflaredInstallError")<{
  readonly message: string
}> {}

const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared"

export const installCloudflared = (
  dir: string,
  asset: CloudflaredAsset | undefined,
  fetch: (url: URL) => Promise<Response>,
): Effect.Effect<string, CloudflaredInstallError> =>
  Effect.tryPromise({
    try: async () => {
      const target = join(dir, CLOUDFLARED_VERSION)
      const path = join(target, executable)
      if (
        await access(path).then(
          () => true,
          () => false,
        )
      )
        return path
      if (asset === undefined) throw new Error(`Cloudflare publishes no build for ${process.platform} ${process.arch}`)

      const response = await fetch(new URL(asset.url))
      if (!response.ok) throw new Error(`the download answered HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
        throw new Error("the download does not match its checksum")
      }

      await mkdir(dir, { recursive: true })
      const staging = await mkdtemp(join(dir, ".download-"))
      try {
        if (asset.archive === "tgz") {
          await writeFile(join(staging, "release.tgz"), bytes)
          await promisify(execFile)("tar", ["-xzf", "release.tgz", executable], { cwd: staging })
          await rm(join(staging, "release.tgz"))
        } else {
          await writeFile(join(staging, executable), bytes)
        }
        await chmod(join(staging, executable), 0o755)
        await rename(staging, target)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      return path
    },
    catch: (error) => new CloudflaredInstallError({ message: error instanceof Error ? error.message : String(error) }),
  })
