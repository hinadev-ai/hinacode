import { ArrowUpRightIcon, CircleIcon, CursorIcon, EyeOffIcon, PencilIcon, UndoIcon } from "@hinacode/icons"
import { formatForDisplay } from "@tanstack/react-hotkeys"
import { cn } from "cn"
import { type ComponentType, type ReactElement, startTransition } from "react"
import { RiNumber1, RiRectangleLine, RiText } from "react-icons/ri"
import { type Color, PALETTE } from "../../lib/imageEdit/document.ts"
import { TOOL_KEYS, type Tool } from "../../lib/imageEdit/gesture.ts"
import { m } from "../../paraglide/messages.js"
import { Kbd } from "../ui/kbd.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx"

const TOOL_ICONS: Record<Tool, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  select: CursorIcon,
  arrow: ArrowUpRightIcon,
  rect: RiRectangleLine,
  ellipse: CircleIcon,
  pen: PencilIcon,
  text: RiText,
  marker: RiNumber1,
  redact: EyeOffIcon,
}

export const toolLabel = (tool: Tool) =>
  ({
    select: m.image_editor_tool_select(),
    arrow: m.image_editor_tool_arrow(),
    rect: m.image_editor_tool_rect(),
    ellipse: m.image_editor_tool_ellipse(),
    pen: m.image_editor_tool_pen(),
    text: m.image_editor_tool_text(),
    marker: m.image_editor_tool_marker(),
    redact: m.image_editor_tool_redact(),
  })[tool]

const ICON_BUTTON =
  "grid size-8 place-items-center rounded-lg text-popover-foreground/80 pressable outline-none hover:bg-foreground/8 hover:text-popover-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35"

function Hint({ label, keys, children }: { label: string; keys: ReadonlyArray<string>; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent className="flex items-center gap-1.5">
        {label}
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

export function EditorToolbar({
  tool,
  color,
  canUndo,
  canRedo,
  onTool,
  onColor,
  onUndo,
  onRedo,
}: {
  tool: Tool
  color: Color
  canUndo: boolean
  canRedo: boolean
  onTool: (tool: Tool) => void
  onColor: (color: Color) => void
  onUndo: () => void
  onRedo: () => void
}) {
  return (
    <div
      role="toolbar"
      aria-label={m.image_editor_toolbar()}
      className="flex items-center gap-1 rounded-2xl bg-popover/95 p-1.5 text-popover-foreground shadow-2xl ring-1 ring-foreground/10 backdrop-blur-md"
    >
      {TOOL_KEYS.map(([each, key]) => {
        const Icon = TOOL_ICONS[each]
        return (
          <Hint key={each} label={toolLabel(each)} keys={[key.toUpperCase()]}>
            <button
              type="button"
              aria-label={toolLabel(each)}
              aria-pressed={tool === each}
              onClick={() => startTransition(() => onTool(each))}
              className={cn(
                ICON_BUTTON,
                "aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary",
              )}
            >
              <Icon aria-hidden className="size-4" />
            </button>
          </Hint>
        )
      })}
      <span aria-hidden className="mx-1 h-5 w-px bg-foreground/10" />
      <fieldset className="flex items-center gap-0.5">
        <legend className="sr-only">{m.image_editor_colors()}</legend>
        {PALETTE.map((each, index) => (
          <Hint key={each} label={m.image_editor_color({ n: index + 1 })} keys={[String(index + 1)]}>
            <button
              type="button"
              aria-pressed={color === each}
              aria-label={m.image_editor_color({ n: index + 1 })}
              onClick={() => startTransition(() => onColor(each))}
              className="grid size-7 place-items-center rounded-full pressable outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                style={{ backgroundColor: each }}
                className="size-4 rounded-full ring-1 ring-foreground/25 ring-inset in-aria-pressed:ring-2 in-aria-pressed:ring-popover in-aria-pressed:outline-2 in-aria-pressed:outline-foreground"
              />
            </button>
          </Hint>
        ))}
      </fieldset>
      <span aria-hidden className="mx-1 h-5 w-px bg-foreground/10" />
      <Hint label={m.image_editor_undo()} keys={[formatForDisplay("Mod+Z")]}>
        <button
          type="button"
          aria-label={m.image_editor_undo()}
          disabled={!canUndo}
          onClick={() => startTransition(onUndo)}
          className={ICON_BUTTON}
        >
          <UndoIcon aria-hidden className="size-4" />
        </button>
      </Hint>
      <Hint label={m.image_editor_redo()} keys={[formatForDisplay("Mod+Shift+Z")]}>
        <button
          type="button"
          aria-label={m.image_editor_redo()}
          disabled={!canRedo}
          onClick={() => startTransition(onRedo)}
          className={ICON_BUTTON}
        >
          <UndoIcon aria-hidden className="size-4 -scale-x-100" />
        </button>
      </Hint>
    </div>
  )
}
