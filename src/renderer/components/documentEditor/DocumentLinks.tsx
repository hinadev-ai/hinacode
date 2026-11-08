import { Popover } from "@base-ui/react/popover"
import { GlobeIcon, PencilIcon, UnlinkIcon } from "@hinacode/icons"
import { type Editor, posToDOMRect } from "@tiptap/core"
import { useEditorState } from "@tiptap/react"
import { type RefObject, useEffect, useId, useRef, useState } from "react"
import { linkHref } from "../../../shared/documentLink.ts"
import { editedLink, editLink, hrefIn, type LinkRange, linkOfElement, openLink, removeLink } from "./linkEditing.ts"
import { m } from "../../paraglide/messages.js"
import { CopyButton } from "../CopyButton.tsx"
import { Button } from "../ui/button.tsx"

const OPEN_DELAY_MS = 500
const CLOSE_DELAY_MS = 200

export const popupSurface =
  "origin-(--transform-origin) rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden transition-[opacity,scale] duration-150 ease-out data-starting-style:opacity-0 motion-safe:data-starting-style:scale-97"

const field =
  "h-8 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:text-destructive"

type Hover = { readonly link: HTMLAnchorElement | null; readonly open: boolean }

const createHoverIntent = (setHover: (update: (hover: Hover) => Hover) => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: HTMLAnchorElement | null = null
  const later = (link: HTMLAnchorElement | null, delay: number) => {
    if (link === pending && timer !== undefined) return
    clearTimeout(timer)
    pending = link
    timer = setTimeout(() => {
      timer = undefined
      setHover((hover) => (link === null ? { ...hover, open: false } : { link, open: true }))
    }, delay)
  }
  return {
    point: (link: HTMLAnchorElement | null) => later(link, link === null ? CLOSE_DELAY_MS : OPEN_DELAY_MS),
    stay: () => {
      clearTimeout(timer)
      timer = undefined
      pending = null
    },
    close: () => {
      clearTimeout(timer)
      timer = undefined
      pending = null
      setHover((hover) => ({ ...hover, open: false }))
    },
  }
}

export function LinkHoverCard({ editor }: { editor: Editor }) {
  const [hover, setHover] = useState<Hover>({ link: null, open: false })
  const [intent] = useState(() => createHoverIntent(setHover))
  const editing = useEditorState({ editor, selector: ({ editor: current }) => editedLink(current) !== null })

  useEffect(() => {
    const dom = editor.view.dom
    const pointerOver = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest("[data-link-card]")) return intent.stay()
      const link = target !== null && dom.contains(target) ? target.closest("a[href]") : null
      intent.point(link instanceof HTMLAnchorElement ? link : null)
    }
    const pointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) intent.point(null)
    }
    const transaction = ({ transaction: change }: { transaction: { docChanged: boolean } }) => {
      if (change.docChanged) intent.close()
    }
    document.addEventListener("pointerover", pointerOver)
    document.addEventListener("pointerout", pointerOut)
    editor.on("transaction", transaction)
    return () => {
      intent.close()
      document.removeEventListener("pointerover", pointerOver)
      document.removeEventListener("pointerout", pointerOut)
      editor.off("transaction", transaction)
    }
  }, [editor, intent])

  const { link } = hover
  const href = link?.getAttribute("href") ?? ""
  return (
    <Popover.Root
      open={hover.open && !editing && link?.isConnected === true}
      onOpenChange={(open) => {
        if (!open) intent.close()
      }}
    >
      <Popover.Portal>
        <Popover.Positioner anchor={link} side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            initialFocus={false}
            finalFocus={false}
            data-link-card
            className={`${popupSurface} flex max-w-96 items-center gap-0.5 p-0.5 data-ending-style:opacity-0`}
          >
            <a
              href={href}
              title={href}
              onClick={(event) => {
                event.preventDefault()
                openLink(href)
              }}
              className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <GlobeIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{href.replace(/^https?:\/\//, "")}</span>
            </a>
            <CopyButton value={href} label={m.documents_link_copy()} />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={m.documents_link_edit()}
              title={m.documents_link_edit()}
              onClick={() => {
                const range = link === null ? null : linkOfElement(editor, link)
                intent.close()
                if (range !== null) editLink(editor, range)
              }}
            >
              <PencilIcon aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={m.documents_link_remove()}
              title={m.documents_link_remove()}
              onClick={() => {
                const range = link === null ? null : linkOfElement(editor, link)
                intent.close()
                if (range !== null) removeLink(editor, range)
                editor.commands.focus()
              }}
            >
              <UnlinkIcon aria-hidden />
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function LinkEditor({ editor }: { editor: Editor }) {
  const range = useEditorState({ editor, selector: ({ editor: current }) => editedLink(current) })
  const address = useRef<HTMLInputElement>(null)
  const close = () => editLink(editor, null)
  return (
    <Popover.Root
      open={range !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={
            range === null
              ? null
              : {
                  contextElement: editor.view.dom,
                  getBoundingClientRect: () => posToDOMRect(editor.view, range.from, range.to),
                }
          }
          side="bottom"
          align="start"
          sideOffset={6}
          className="isolate z-50"
        >
          <Popover.Popup
            initialFocus={address}
            finalFocus={() => editor.view.dom}
            className={`${popupSurface} w-72 p-3`}
          >
            {range !== null && (
              <LinkForm
                key={`${range.from}:${range.to}`}
                editor={editor}
                range={range}
                address={address}
                onDone={close}
              />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function LinkForm({
  editor,
  range,
  address,
  onDone,
}: {
  editor: Editor
  range: LinkRange
  address: RefObject<HTMLInputElement | null>
  onDone: () => void
}) {
  const [original] = useState(() => ({
    text: editor.state.doc.textBetween(range.from, range.to, " "),
    href: range.from < range.to ? hrefIn(editor, range) : null,
  }))
  const [text, setText] = useState(original.text)
  const [href, setHref] = useState(original.href ?? "")
  const target = linkHref(href)
  const textId = useId()
  const hrefId = useId()

  const save = () => {
    if (target === null) return
    const label = text.trim() === "" ? target : text
    const chain = editor.chain()
    if (label === original.text)
      chain.setTextSelection(range).setLink({ href: target }).setTextSelection(range.to).run()
    else
      chain
        .insertContentAt(range, { type: "text", text: label, marks: [{ type: "link", attrs: { href: target } }] })
        .run()
    onDone()
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={textId} className="text-xs font-medium text-muted-foreground">
          {m.documents_link_text()}
        </label>
        <input id={textId} value={text} onChange={(event) => setText(event.target.value)} className={field} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={hrefId} className="text-xs font-medium text-muted-foreground">
          {m.documents_link()}
        </label>
        <input
          id={hrefId}
          ref={address}
          value={href}
          onChange={(event) => setHref(event.target.value)}
          placeholder={m.documents_link_placeholder()}
          aria-invalid={href.trim() !== "" && target === null}
          className={field}
        />
      </div>
      <div className="flex items-center gap-1">
        {original.href !== null && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => {
              removeLink(editor, range)
              onDone()
            }}
          >
            <UnlinkIcon aria-hidden />
            {m.documents_link_remove()}
          </Button>
        )}
        <Button type="button" variant="ghost" size="xs" className="ms-auto" onClick={onDone}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" size="xs" disabled={target === null}>
          {m.documents_link_save()}
        </Button>
      </div>
    </form>
  )
}
