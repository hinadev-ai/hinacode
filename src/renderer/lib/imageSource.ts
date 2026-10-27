import { attachmentUrl, githubAssetUrl } from "../../shared/channels.ts"

interface ImageContext {
  readonly environment: string | null
  /** Resolves relative paths, for a file shown from disk. */
  readonly baseUrl: string | null
  /** The thread's folder, where the agent's paths point. Null outside a thread. */
  readonly root: string | null
}

/**
 * The URL an agent's Markdown image loads from. Agents embed files they saved on this machine, like `vm_screenshot`
 * captures, by absolute path. Markdown percent-encodes the path, as in `Application%20Support`, so it is decoded back first.
 */
export const imageSource = (src: string, { environment, baseUrl }: ImageContext) => {
  const asset = githubAssetUrl(src)
  if (asset !== null) return asset
  if (src.startsWith("/")) return attachmentUrl(decodeURI(src), environment)
  return baseUrl === null ? src : new URL(src, baseUrl).href
}
