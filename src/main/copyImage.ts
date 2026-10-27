import { clipboard, ClipboardItem, nativeImage, net } from "electron"
import { Effect, Schema } from "effect"
import { ATTACHMENT_PROTOCOL, GITHUB_ASSET_PROTOCOL, PROJECT_FILE_PROTOCOL } from "../shared/channels.ts"

const IMAGE_PROTOCOLS = new Set([
  "https:",
  "http:",
  `${ATTACHMENT_PROTOCOL}:`,
  `${GITHUB_ASSET_PROTOCOL}:`,
  `${PROJECT_FILE_PROTOCOL}:`,
])

export class CopyImageError extends Schema.TaggedError<CopyImageError>()("CopyImageError", {
  message: Schema.String,
}) {}

/**
 * Puts the image at `url` on the clipboard. Our schemes are fetched through the same handlers that serve the
 * window, so a copy reaches no file the window could not show; `file:` is refused for the same reason.
 */
export const copyImage = (url: string): Effect.Effect<void, CopyImageError> =>
  Effect.tryPromise({
    try: async () => {
      if (!IMAGE_PROTOCOLS.has(URL.parse(url)?.protocol ?? "")) throw new Error("Only web and app images can be copied")
      const response = await net.fetch(url)
      if (!response.ok) throw new Error(`The image answered ${response.status}`)
      const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()))
      if (image.isEmpty()) throw new Error("Only PNG and JPEG images can be copied")
      await clipboard.write([
        new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) }),
      ])
    },
    catch: (cause) => new CopyImageError({ message: cause instanceof Error ? cause.message : String(cause) }),
  })
