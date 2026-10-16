export const RPC_CHANNEL = "rpc"
export const EVENT_CHANNEL = "event"

/** Custom scheme main serves staged attachments from, so the sandboxed renderer can show thumbnails. */
export const ATTACHMENT_PROTOCOL = "hinacode-attachment"

/** `environment` names the cloud the file was staged on; main fetches it from there. */
export const attachmentUrl = (path: string, environment: string | null = null) =>
  `${ATTACHMENT_PROTOCOL}://file/${encodeURIComponent(path)}${environment === null ? "" : `?environment=${encodeURIComponent(environment)}`}`

/** Custom scheme main proxies private GitHub attachments through, signed in with the user's `gh` token. */
export const GITHUB_ASSET_PROTOCOL = "hinacode-github-asset"

const GITHUB_ASSET = /^https:\/\/github\.com\/user-attachments\/assets\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/

/** The `hinacode-github-asset` URL for a `github.com/user-attachments/assets/<id>` link, or null for any other URL. */
export const githubAssetUrl = (url: string | undefined): string | null => {
  const id = GITHUB_ASSET.exec(url ?? "")?.[1]
  return id === undefined ? null : `${GITHUB_ASSET_PROTOCOL}://asset/${id}`
}

/** Custom scheme main serves files of project roots and worktrees from, for media and HTML previews. */
export const PROJECT_FILE_PROTOCOL = "hinacode-file"

/**
 * The `hinacode-file` URL of `path` (relative, `/`-separated) under `root`. The root is one path segment,
 * so relative links in a served HTML file resolve to siblings under the same root.
 */
export const projectFileUrl = (root: string, path: string) =>
  `${PROJECT_FILE_PROTOCOL}://root/${encodeURIComponent(root)}/${path.split("/").map(encodeURIComponent).join("/")}`
