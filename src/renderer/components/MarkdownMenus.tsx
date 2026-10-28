import type { ReactElement, ReactNode } from "react"
import { RiExternalLinkLine, RiFileCopyLine, RiImageLine, RiLinksLine } from "react-icons/ri"
import { toast } from "sonner"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { OpenWithSubmenu } from "./OpenWith.tsx"
import { isWebUrl } from "./WebLink.tsx"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "./ui/context-menu.tsx"
import { DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu.tsx"

const copyText = (text: string) => void navigator.clipboard.writeText(text)

const copyImage = (url: string) =>
  callPromise("clipboard.copyImage", { url }).catch((cause: unknown) =>
    toast.error(m.markdown_copy_image_failed({ message: errorMessage(cause) })),
  )

interface ImageMenuProps {
  /** The `<img>` the menu opens on. */
  readonly image: ReactElement
  /** The URL the image loads from. */
  readonly url: string
  /** The image as the agent wrote it, a path or a URL. */
  readonly address: string
  /** The file on this machine, for "Open with". */
  readonly path: string | null
}

export function ImageMenu({ image, url, address, path }: ImageMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={image} />
      <ContextMenuContent>
        <DropdownMenuItem onClick={() => void copyImage(url)}>
          <RiImageLine aria-hidden />
          {m.markdown_copy_image()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => copyText(address)}>
          <RiFileCopyLine aria-hidden />
          {path === null ? m.markdown_copy_image_address() : m.explorer_copy_path()}
        </DropdownMenuItem>
        {path !== null && (
          <>
            <DropdownMenuSeparator />
            <OpenWithSubmenu path={path} target="file" />
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function LinkMenu({ href, children }: { href: string; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span />}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {isWebUrl(href) && (
          // Main opens a new window's web URL in the system browser, the same way a click on the link does.
          <DropdownMenuItem onClick={() => void window.open(href, "_blank", "noreferrer")}>
            <RiExternalLinkLine aria-hidden />
            {m.markdown_open_link()}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => copyText(href)}>
          <RiLinksLine aria-hidden />
          {m.markdown_copy_link()}
        </DropdownMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
