import { attachmentUrl, externalImageUrl, githubAssetUrl, projectFileUrl } from "../../shared/channels.ts"

interface ImageContext {
  readonly environment: string | null
  readonly baseUrl: string | null
  readonly root: string | null
}

export const imageSource = (src: string, { environment, baseUrl, root }: ImageContext) => {
  const asset = githubAssetUrl(src)
  if (asset !== null) return asset
  const external = externalImageUrl(src)
  if (external !== null) return external
  if (src.startsWith("/")) {
    const path = decodeURI(src)
    return root !== null && path.startsWith(`${root}/`)
      ? projectFileUrl(root, path.slice(root.length + 1))
      : attachmentUrl(path, environment)
  }
  const base = baseUrl ?? (root === null ? null : projectFileUrl(root, ""))
  return base === null ? src : new URL(src, base).href
}

export const imageSrcSet = (srcSet: string, context: ImageContext) => {
  if (srcSet.includes("data:")) return srcSet
  return srcSet
    .split(",")
    .map((entry) => {
      const [url, ...descriptor] = entry.trim().split(/\s+/)
      return url ? [imageSource(url, context), ...descriptor].join(" ") : entry
    })
    .join(", ")
}
