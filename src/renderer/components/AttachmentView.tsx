import { cn } from "cn"
import { useState } from "react"
import { attachmentUrl } from "../../shared/channels.ts"
import type { Attachment, PickedElement } from "../../shared/domain.ts"
import { elementLabel } from "../lib/elementPicker.ts"
import { useOpenThreadEnvironment } from "../lib/environments.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { Button } from "./ui/button.tsx"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog.tsx"
import { CloseIcon } from "./icons/CloseIcon.tsx"
import { FileIcon } from "./icons/FileIcon.tsx"

const format = (value: number, unit: string) =>
  new Intl.NumberFormat(getLocale(), { style: "unit", unit, maximumFractionDigits: 1 }).format(value)

const formatBytes = (bytes: number) => {
  if (bytes >= 1024 * 1024) return format(bytes / 1024 / 1024, "megabyte")
  if (bytes >= 1024) return format(bytes / 1024, "kilobyte")
  return format(bytes, "byte")
}

/** A sent attachment: an image opens full size, a file reveals in the file manager. */
export function AttachmentView({ attachment }: { attachment: Attachment }) {
  if (attachment.kind === "image") return <ImageAttachment attachment={attachment} />
  return (
    <button
      type="button"
      onClick={() => void callPromise("shell.reveal", { path: attachment.path })}
      title={m.attachment_reveal({ name: attachment.name })}
      className="pressable rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FileChip attachment={attachment} />
    </button>
  )
}

const useAttachmentSrc = (attachment: Attachment) => attachmentUrl(attachment.path, useOpenThreadEnvironment())

function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const { element } = attachment
  const src = useAttachmentSrc(attachment)
  // The staged copy can be gone, for example when the thread came from another machine.
  const [missing, setMissing] = useState(false)
  const title = element ? elementLabel(element) : attachment.name
  if (missing) return <FileChip attachment={attachment} />
  return (
    <Dialog>
      <DialogTrigger
        title={m.attachment_open_image({ name: title })}
        className="pressable rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Preview attachment={attachment} onError={() => setMissing(true)} />
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] sm:max-w-4xl">
        <DialogTitle className={cn("truncate pr-8", element && "font-mono text-sm")}>{title}</DialogTitle>
        <img
          src={src}
          alt={attachment.name}
          className={cn("max-h-[70vh] rounded-md object-contain", element ? "mx-auto max-w-full" : "w-full")}
        />
        {element && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{m.attachment_element_url()}</dt>
            <dd className="truncate font-mono">{element.url}</dd>
            <dt className="text-muted-foreground">{m.attachment_element_selector()}</dt>
            <dd className="truncate font-mono">{element.selector}</dd>
          </dl>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Preview({ attachment, onError }: { attachment: Attachment; onError?: () => void }) {
  if (attachment.element) return <ElementChip attachment={attachment} element={attachment.element} onError={onError} />
  return attachment.kind === "image" ? (
    <Thumbnail attachment={attachment} onError={onError} />
  ) : (
    <FileChip attachment={attachment} />
  )
}

/** An attachment waiting in the composer, with a remove button. */
export function PendingAttachment({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  return (
    <div className="relative">
      <Preview attachment={attachment} />
      <Button
        type="button"
        size="icon-xs"
        variant="secondary"
        onClick={onRemove}
        aria-label={m.attachment_remove({
          name: attachment.element
            ? m.attachment_element({ element: elementLabel(attachment.element) })
            : attachment.name,
        })}
        className="absolute -top-1.5 -right-1.5 rounded-full border border-border"
      >
        <CloseIcon aria-hidden />
      </Button>
    </div>
  )
}

function Thumbnail({ attachment, onError }: { attachment: Attachment; onError?: () => void }) {
  const src = useAttachmentSrc(attachment)
  return (
    <img
      src={src}
      alt={attachment.name}
      onError={onError}
      className="size-16 rounded-lg border border-border object-cover"
    />
  )
}

function FileChip({ attachment }: { attachment: Attachment }) {
  return (
    <span className="flex h-16 max-w-56 items-center gap-2 rounded-lg border border-border bg-background/50 px-3 text-left text-xs">
      <FileIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="text-muted-foreground">{formatBytes(attachment.bytes)}</span>
      </span>
    </span>
  )
}

/** A screenshot of an element picked in the browser, named by its tag and where it lives. */
function ElementChip({
  attachment,
  element,
  onError,
}: {
  attachment: Attachment
  element: PickedElement
  onError?: () => void
}) {
  const url = URL.parse(element.url)
  const tag = elementLabel(element)
  const src = useAttachmentSrc(attachment)
  return (
    <span className="flex h-16 w-64 items-center gap-2 overflow-hidden rounded-lg border border-border bg-background/50 pr-3 text-left text-xs">
      <img
        src={src}
        alt={m.attachment_element({ element: tag })}
        onError={onError}
        className="h-full w-20 shrink-0 border-r border-border bg-muted object-contain p-1"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-mono font-medium" title={element.selector}>
          {tag}
        </span>
        <span className="truncate text-muted-foreground" title={element.url}>
          {url ? `${url.host}${url.pathname}` : element.url}
        </span>
      </span>
    </span>
  )
}
