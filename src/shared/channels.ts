export const RPC_CHANNEL = "rpc"
export const EVENT_CHANNEL = "event"

export const LIQUID_GLASS_ARGUMENT = "--hinacode-liquid-glass"

export const ATTACHMENT_PROTOCOL = "hinacode-attachment"

export const attachmentUrl = (path: string, environment: string | null = null) =>
  `${ATTACHMENT_PROTOCOL}://file/${encodeURIComponent(path)}${environment === null ? "" : `?environment=${encodeURIComponent(environment)}`}`

export const GITHUB_ASSET_PROTOCOL = "hinacode-github-asset"

const GITHUB_ASSET = /^https:\/\/github\.com\/user-attachments\/assets\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/

export const githubAssetUrl = (url: string | undefined): string | null => {
  const id = GITHUB_ASSET.exec(url ?? "")?.[1]
  return id === undefined ? null : `${GITHUB_ASSET_PROTOCOL}://asset/${id}`
}

export const EXTERNAL_IMAGE_PROTOCOL = "hinacode-image"

export const externalImageUrl = (url: string | undefined): string | null => {
  const target = url?.startsWith("//") ? `https:${url}` : url
  return target !== undefined && /^https?:\/\//i.test(target)
    ? `${EXTERNAL_IMAGE_PROTOCOL}://image/${encodeURIComponent(target)}`
    : null
}

export const PROJECT_FILE_PROTOCOL = "hinacode-file"

export const projectFileUrl = (root: string, path: string) =>
  `${PROJECT_FILE_PROTOCOL}://root/${encodeURIComponent(root)}/${path.split("/").map(encodeURIComponent).join("/")}`

export const ARTIFACT_PROTOCOL = "hinacode-artifact"

export const artifactUrl = (id: string, path = "") =>
  `${ARTIFACT_PROTOCOL}://${id}/${path.split("/").map(encodeURIComponent).join("/")}`

export const WEB_RESOURCE_PATH = "/_r/"

const DESKTOP_RESOURCE = /^(hinacode-[a-z-]+):\/\/(.*)$/s

export const webResourceUrl = (url: string): string => {
  const [, scheme, rest] = DESKTOP_RESOURCE.exec(url) ?? []
  if (scheme === undefined || rest === undefined) return url
  if (scheme === EXTERNAL_IMAGE_PROTOCOL) return decodeURIComponent(rest.replace(/^image\//, ""))
  if (scheme === GITHUB_ASSET_PROTOCOL)
    return `https://github.com/user-attachments/assets/${rest.replace(/^asset\//, "")}`
  return `${WEB_RESOURCE_PATH}${scheme}/${rest}`
}

export const desktopResourceUrl = (url: URL): string | null =>
  url.pathname.startsWith(WEB_RESOURCE_PATH)
    ? url.pathname.slice(WEB_RESOURCE_PATH.length).replace("/", "://") + url.search
    : null
