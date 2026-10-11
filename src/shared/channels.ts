export const RPC_CHANNEL = "rpc"
export const EVENT_CHANNEL = "event"

/** Custom scheme main serves staged attachments from, so the sandboxed renderer can show thumbnails. */
export const ATTACHMENT_PROTOCOL = "kkcode-attachment"

export const attachmentUrl = (path: string) => `${ATTACHMENT_PROTOCOL}://file/${encodeURIComponent(path)}`
