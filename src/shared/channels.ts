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

export const PROJECT_FILE_PROTOCOL = "hinacode-file"

export const projectFileUrl = (root: string, path: string) =>
  `${PROJECT_FILE_PROTOCOL}://root/${encodeURIComponent(root)}/${path.split("/").map(encodeURIComponent).join("/")}`
