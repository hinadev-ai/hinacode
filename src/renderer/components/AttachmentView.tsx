import { RiCloseLine, RiFileLine } from "react-icons/ri"
import { attachmentUrl } from "../../shared/channels.ts"
import type { Attachment } from "../../shared/domain.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { Button } from "./ui/button.tsx"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog.tsx"

const formatBytes = (bytes: number) => {
  const [value, unit] = bytes >= 1024 * 1024 ? [bytes / 1024 / 1024, "megabyte"] : [bytes / 1024, "kilobyte"]
  return new Intl.NumberFormat(getLocale(), { style: "unit", unit, maximumFractionDigits: 1 }).format(value)
}

/** A sent attachment: an image opens full size, a file reveals in the file manager. */
export function AttachmentView({ attachment }: { attachment: Attachment }) {
  if (attachment.kind === "image") return <ImageAttachment attachment={attachment} />
  return (
    <button
      type="button"
      onClick={() => void callPromise("shell.reveal", { path: attachment.path })}
      title={m.attachment_reveal({ name: attachment.name })}
      className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FileChip attachment={attachment} />
    </button>
  )
}

function ImageAttachment({ attachment }: { attachment: Attachment }) {
  return (
    <Dialog>
      <DialogTrigger
        title={m.attachment_open_image({ name: attachment.name })}
        className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Thumbnail attachment={attachment} />
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] sm:max-w-4xl">
        <DialogTitle className="truncate pr-8">{attachment.name}</DialogTitle>
        <img
          src={attachmentUrl(attachment.path)}
          alt={attachment.name}
          className="max-h-[75vh] w-full rounded-md object-contain"
        />
      </DialogContent>
    </Dialog>
  )
}

/** An attachment waiting in the composer, with a remove button. */
export function PendingAttachment({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  return (
    <div className="relative">
      {attachment.kind === "image" ? <Thumbnail attachment={attachment} /> : <FileChip attachment={attachment} />}
      <Button
        type="button"
        size="icon-xs"
        variant="secondary"
        onClick={onRemove}
        aria-label={m.attachment_remove({ name: attachment.name })}
        className="absolute -top-1.5 -right-1.5 rounded-full border border-border"
      >
        <RiCloseLine aria-hidden />
      </Button>
    </div>
  )
}

function Thumbnail({ attachment }: { attachment: Attachment }) {
  return (
    <img
      src={attachmentUrl(attachment.path)}
      alt={attachment.name}
      className="size-16 rounded-lg border border-border object-cover"
    />
  )
}

function FileChip({ attachment }: { attachment: Attachment }) {
  return (
    <span className="flex h-16 max-w-56 items-center gap-2 rounded-lg border border-border bg-background/50 px-3 text-left text-xs">
      <RiFileLine aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="text-muted-foreground">{formatBytes(attachment.bytes)}</span>
      </span>
    </span>
  )
}
