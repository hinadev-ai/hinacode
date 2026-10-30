import { attachmentUrl, githubAssetUrl, projectFileUrl } from "../../shared/channels.ts"

interface ImageContext {
  readonly environment: string | null
  readonly baseUrl: string | null
  readonly root: string | null
}

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
