import { attachmentUrl, githubAssetUrl, projectFileUrl } from "../../shared/channels.ts"

interface ImageContext {
  readonly environment: string | null
  /** Resolves relative paths, for a file shown from disk. */
  readonly baseUrl: string | null
  /** The thread's folder, where the agent's paths point. Null outside a thread. */
  readonly root: string | null
}

/**
 * The URL an agent's Markdown image loads from. Agents embed files by path: screenshots they saved into their
 * folder, absolute or relative to it, and `vm_screenshot` captures, which land in the attachments dir. Markdown
 * percent-encodes the path, as in `Application%20Support`, so it is decoded back first.
 */
export const imageSource = (src: string, { environment, baseUrl, root }: ImageContext) => {
  const asset = githubAssetUrl(src)
  if (asset !== null) return asset
  if (src.startsWith("/")) {
    const path = decodeURI(src)
    return root !== null && path.startsWith(`${root}/`)
      ? projectFileUrl(root, path.slice(root.length + 1))
      : attachmentUrl(path, environment)
  }
  const base = baseUrl ?? (root === null ? null : projectFileUrl(root, ""))
  return base === null ? src : new URL(src, base).href
}
