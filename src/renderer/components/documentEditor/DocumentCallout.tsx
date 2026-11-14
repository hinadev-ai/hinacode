import { AlertIcon, ChevronDownIcon, InfoIcon } from "@hinacode/icons"
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react"
import type { ComponentType, CSSProperties } from "react"
import { RiDoubleQuotesL, RiFeedbackLine, RiLightbulbLine, RiSpam2Line } from "react-icons/ri"
import { CALLOUT_TONES, calloutTone, type CalloutTone, isCalloutTone } from "../../../shared/documentCallout.ts"
import { DocumentCallout as SharedCallout } from "../../../shared/document/schema.ts"
import { m } from "../../paraglide/messages.js"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx"

const TONES: Record<
  CalloutTone,
  {
    readonly color: string
    readonly label: () => string
    readonly icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  }
> = {
  note: { color: "--graph-lane-1", label: m.documents_callout_note, icon: InfoIcon },
  tip: { color: "--graph-lane-2", label: m.documents_callout_tip, icon: RiLightbulbLine },
  important: { color: "--callout-important", label: m.documents_callout_important, icon: RiFeedbackLine },
  warning: { color: "--attention", label: m.documents_callout_warning, icon: AlertIcon },
  caution: { color: "--destructive", label: m.documents_callout_caution, icon: RiSpam2Line },
}

const insideControl = (event: Event) =>
  event.target instanceof Element && event.target.closest("[data-node-control]") !== null

export const DocumentCallout = SharedCallout.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView, { stopEvent: ({ event }) => insideControl(event) })
  },
})

function CalloutView({ node, editor, getPos, updateAttributes }: ReactNodeViewProps) {
  const tone = calloutTone(node.attrs["tone"])
  const toQuote = () => {
    const position = getPos()
    const blockquote = editor.schema.nodes["blockquote"]
    if (position === undefined || blockquote === undefined) return
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setNodeMarkup(position, blockquote)
        return true
      })
      .run()
  }
  return (
    <NodeViewWrapper
      data-callout
      data-tone={tone}
      style={{ "--callout-tone": `var(${TONES[tone].color})` } as CSSProperties}
      className="group/callout my-6 rounded-[10px] px-4 pt-2.5 pb-3"
    >
      <div contentEditable={false} data-node-control className="mb-1 flex">
        <TonePicker tone={tone} onTone={(next) => updateAttributes({ tone: next })} onQuote={toQuote} />
      </div>
      <NodeViewContent />
    </NodeViewWrapper>
  )
}

function TonePicker({
  tone,
  onTone,
  onQuote,
}: {
  tone: CalloutTone
  onTone: (tone: CalloutTone) => void
  onQuote: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={m.documents_callout_type({ type: TONES[tone].label() })}
        data-callout-label
        className="-ms-1.5 flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ToneLabel tone={tone} />
        <ChevronDownIcon
          data-print-hidden
          className="size-3 opacity-0 transition-opacity duration-150 ease-out group-focus-within/callout:opacity-70 group-hover/callout:opacity-70"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-40">
        <DropdownMenuRadioGroup
          value={tone}
          onValueChange={(next) => {
            if (isCalloutTone(next)) onTone(next)
          }}
        >
          {CALLOUT_TONES.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              closeOnClick
              style={{ "--callout-tone": `var(${TONES[option].color})` } as CSSProperties}
            >
              <ToneLabel tone={option} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onQuote}>
          <RiDoubleQuotesL aria-hidden className="text-muted-foreground" />
          {m.documents_quote()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ToneLabel({ tone }: { tone: CalloutTone }) {
  const Icon = TONES[tone].icon
  return (
    <>
      <Icon aria-hidden data-callout-icon className="size-3.5 shrink-0" />
      {TONES[tone].label()}
    </>
  )
}
