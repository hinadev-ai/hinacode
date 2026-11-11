import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { SpinnerIcon } from "@hinacode/icons"
import { formatForDisplay } from "@tanstack/react-hotkeys"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  startTransition,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react"
import { AGENT_IMAGE_MAX_BYTES } from "../../../shared/agentImages.ts"
import { cursorFor, dimOutside, drawCropFrame, drawSelection } from "../../lib/imageEdit/chrome.ts"
import {
  canRedo,
  canUndo,
  type Color,
  type Command,
  imageBounds,
  PALETTE,
  type Point,
  push,
  redo,
  replay,
  type Shape,
  undo,
  visibleRect,
} from "../../lib/imageEdit/document.ts"
import { exportDocument } from "../../lib/imageEdit/export.ts"
import {
  type BoxOf,
  handleAt,
  rectHandles,
  shapeBounds,
  shapeHandles,
  topmostShapeAt,
  translate,
} from "../../lib/imageEdit/geometry.ts"
import {
  dragTo,
  fitView,
  finish,
  type Gesture,
  idle,
  isDrawingTool,
  previewDocument,
  type Size,
  startDrawing,
  TOOL_KEYS,
  toImage,
  toScreen,
  type Tool,
  type View,
} from "../../lib/imageEdit/gesture.ts"
import {
  annotationUnit,
  drawDocument,
  type EditSource,
  FONT_FAMILY,
  layoutText,
  markerBox,
  textPill,
} from "../../lib/imageEdit/render.ts"
import { readAsDataUrl } from "../../lib/dataUrl.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { useDrafts } from "../../stores/drafts.ts"
import { type EditorRequest, useImageEditor } from "../../stores/imageEditor.ts"
import { Button } from "../ui/button.tsx"
import { Kbd } from "../ui/kbd.tsx"
import { EditorToolbar } from "./EditorToolbar.tsx"

const STAGE_PADDING = 40
const HANDLE_SLOP = 8
const HIT_SLOP = 6
const MIN_SIZE = 4
const NO_HANDLES: ReturnType<typeof shapeHandles> = []

type DismissDetails = DialogPrimitive.Root.ChangeEventDetails

interface Typing {
  readonly id: string
  readonly existing: boolean
  readonly at: Point
  readonly text: string
  readonly color: Color
}

const editedName = (name: string) => `${name.replace(/(-edited)?\.[^.]+$/, "")}-edited.png`

const isTextField = (target: EventTarget) => target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement

const closeEditor = () => useImageEditor.getState().close()

const returnFocusToEditor = (from: HTMLElement) => from.closest<HTMLElement>("[role=dialog]")?.focus()

const pointAt = (event: { clientX: number; clientY: number; currentTarget: Element }, view: View) => {
  const bounds = event.currentTarget.getBoundingClientRect()
  return toImage(view, event.clientX - bounds.left, event.clientY - bounds.top)
}

export function ImageEditor({ request }: { request: EditorRequest }) {
  if (request.source.status === "ready") return <Editor request={request} source={request.source.source} />
  return (
    <EditorShell title={request.original.name} onDismiss={closeEditor} actions={<CancelButton onClick={closeEditor} />}>
      <div className="grid flex-1 place-items-center text-white/70">
        {request.source.status === "loading" ? (
          <SpinnerIcon aria-label={m.image_editor_loading()} className="size-6 animate-spin" />
        ) : (
          <p role="alert" className="max-w-md text-center text-sm">
            {m.image_editor_load_failed({ message: request.source.message })}
          </p>
        )}
      </div>
    </EditorShell>
  )
}

function EditorShell({
  title,
  subtitle,
  actions,
  onDismiss,
  onKeyDown,
  children,
}: {
  title: string
  subtitle?: string
  actions: ReactNode
  onDismiss: (details: DismissDetails) => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
}) {
  const popupRef = useRef<HTMLDivElement>(null)
  return (
    <DialogPrimitive.Root open disablePointerDismissal onOpenChange={(open, details) => open || onDismiss(details)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-neutral-950/94 backdrop-blur-sm transition-opacity duration-150 ease-out data-starting-style:opacity-0 motion-reduce:transition-none" />
        <DialogPrimitive.Popup
          ref={popupRef}
          initialFocus={popupRef}
          onKeyDown={onKeyDown}
          className="fixed inset-0 z-50 flex flex-col text-white transition-[opacity,scale] duration-150 ease-out outline-none data-starting-style:scale-99 data-starting-style:opacity-0 motion-reduce:transition-none"
        >
          <header className="flex h-14 shrink-0 items-center gap-3 px-4">
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <DialogPrimitive.Title className="truncate text-sm font-medium">{title}</DialogPrimitive.Title>
              {subtitle && <span className="shrink-0 text-xs text-white/50 tabular-nums">{subtitle}</span>}
            </div>
            {actions}
          </header>
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function CancelButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" onClick={onClick} className="text-white/80 hover:bg-white/10 hover:text-white">
      {m.common_cancel()}
    </Button>
  )
}

function useStageSize() {
  const [size, setSize] = useState<Size | null>(null)
  const observe = (element: HTMLDivElement | null) => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }
  return [size, observe] as const
}

function Editor({ request, source }: { request: EditorRequest; source: EditSource }) {
  const [log, setLog] = useState(request.log)
  const [tool, setTool] = useState<Tool>("select")
  const [color, setColor] = useState<Color>(PALETTE[0])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [gesture, setGesture] = useState<Gesture>(idle)
  const [typing, setTyping] = useState<Typing | null>(null)
  const [hoverCursor, setHoverCursor] = useState("default")
  const [error, setError] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()
  const [measurer] = useState(() => new OffscreenCanvas(1, 1).getContext("2d")!)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [stage, observeStage] = useStageSize()

  const image = imageBounds(source.width, source.height)
  const unit = annotationUnit(source)
  const edit = replay(log)
  const visible = visibleRect(edit, source.width, source.height)
  const view: View | null = gesture.kind === "crop" ? gesture.view : stage && fitView(visible, stage, STAGE_PADDING)
  const preview = previewDocument(edit, gesture, typing?.id ?? null)
  const selected = preview.shapes.find((shape) => shape.id === selectedId)
  const boxOf: BoxOf = (shape) =>
    shape.kind === "text" ? layoutText(measurer, shape, unit).box : markerBox(shape, unit)
  const shownCrop = visibleRect(preview, source.width, source.height)
  const showCropFrame = tool === "select" && !selected && typing === null
  const selectionBox = selected ? shapeBounds(selected, boxOf) : null
  const selectionHandles = selected && gesture.kind === "idle" ? shapeHandles(selected) : NO_HANDLES

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !stage || !view) return
    const ratio = window.devicePixelRatio
    const width = Math.round(stage.width * ratio)
    const height = Math.round(stage.height * ratio)
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const ctx = canvas.getContext("2d")!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.offsetX, ratio * view.offsetY)
    drawDocument(ctx, source, preview, shownCrop)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    dimOutside(ctx, view, image, shownCrop)
    if (selectionBox) drawSelection(ctx, view, selectionBox, selectionHandles)
    else if (showCropFrame) drawCropFrame(ctx, view, shownCrop)
  }, [stage, view, source, preview, shownCrop, image, selectionBox, selectionHandles, showCropFrame])

  const apply = (command: Command | null) => {
    if (command) setLog((current) => push(current, command))
  }

  const typingCommand = (draft: Typing): Command | null => {
    const text = draft.text.trimEnd()
    const shape: Shape = { id: draft.id, kind: "text", at: draft.at, text, color: draft.color }
    if (!draft.existing) return text.trim() === "" ? null : { type: "add", shape }
    if (text.trim() === "") return { type: "remove", id: draft.id }
    const before = edit.shapes.find((each) => each.id === draft.id)
    return before?.kind === "text" && before.text === text && before.color === draft.color
      ? null
      : { type: "update", shape }
  }

  const commitTyping = () => {
    if (!typing) return log
    const command = typingCommand(typing)
    setTyping(null)
    if (!command) return log
    const next = push(log, command)
    setLog(next)
    return next
  }

  const cancel = () => {
    const finalLog = commitTyping()
    if (finalLog !== request.log) {
      useImageEditor.getState().remember(request.attachment.id, { original: request.original, log: finalLog })
    }
    closeEditor()
  }

  const done = () => {
    const finalLog = commitTyping()
    if (finalLog === request.log) {
      closeEditor()
      return
    }
    startSaving(async () => {
      setError(null)
      try {
        const blob = await exportDocument(source, replay(finalLog), AGENT_IMAGE_MAX_BYTES)
        const { threadId, attachment, original } = request
        const staged = await callPromise("attachments.stage", {
          threadId,
          source: { dataUrl: await readAsDataUrl(blob), name: editedName(original.name) },
        })
        const edited = { ...staged, element: original.element, deviceElement: original.deviceElement }
        useDrafts.getState().replaceAttachment(threadId, attachment.id, edited)
        useImageEditor.getState().remember(edited.id, { original, log: finalLog })
        closeEditor()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  const dismiss = (details: DismissDetails) => {
    if (details.reason === "escape-key") {
      if (typing) {
        details.cancel()
        if (textRef.current) returnFocusToEditor(textRef.current)
        return
      }
      if (gesture.kind !== "idle" || selectedId !== null) {
        details.cancel()
        startTransition(() => {
          setGesture(idle)
          setSelectedId(null)
        })
        return
      }
    }
    cancel()
  }

  const pickTool = (next: Tool) => {
    setTool(next)
    setSelectedId(null)
  }

  const pickColor = (next: Color) => {
    setColor(next)
    if (selected && "color" in selected && selected.color !== next)
      apply({ type: "update", shape: { ...selected, color: next } })
  }

  const removeSelected = () => {
    if (!selected) return
    apply({ type: "remove", id: selected.id })
    setSelectedId(null)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isTextField(event.target)) return
    const key = event.key.toLowerCase()
    if (event.metaKey || event.ctrlKey) {
      if (key === "z" || key === "y") {
        event.preventDefault()
        setLog(key === "y" || event.shiftKey ? redo : undo)
      }
      return
    }
    if (event.altKey) return
    if (key === "enter") {
      if (event.target instanceof HTMLButtonElement) return
      event.preventDefault()
      done()
      return
    }
    if (key === "delete" || key === "backspace") {
      removeSelected()
      return
    }
    if (key.startsWith("arrow") && selected) {
      event.preventDefault()
      const step = event.shiftKey ? 10 : 1
      const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0
      const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0
      apply({ type: "update", shape: translate(selected, dx, dy) })
      return
    }
    const swatch = PALETTE[Number(event.key) - 1]
    if (swatch) {
      pickColor(swatch)
      return
    }
    const shortcut = TOOL_KEYS.find(([, letter]) => letter === key)
    if (shortcut) pickTool(shortcut[0])
  }

  const textAt = (point: Point, current: View) =>
    preview.shapes.findLast(
      (shape): shape is Extract<Shape, { kind: "text" }> =>
        shape.kind === "text" && topmostShapeAt([shape], point, HIT_SLOP / current.scale, boxOf) !== undefined,
    )

  const editText = (shape: Extract<Shape, { kind: "text" }>) => {
    setSelectedId(null)
    setTyping({ id: shape.id, existing: true, at: shape.at, text: shape.text, color: shape.color })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!view || saving) return
    if (event.button === 2) {
      setGesture(idle)
      pickTool("select")
      return
    }
    if (event.button !== 0 || typing) return
    const point = pointAt(event, view)
    const handleSlop = HANDLE_SLOP / view.scale
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === "select") {
      const handle = selected && handleAt(shapeHandles(selected), point, handleSlop)
      if (selected && handle) {
        setGesture({ kind: "resize", handle, original: selected, shape: selected })
        return
      }
      const cropHandle = !selected && handleAt(rectHandles(visible), point, handleSlop)
      if (cropHandle) {
        setGesture({ kind: "crop", handle: cropHandle, original: visible, rect: visible, view })
        return
      }
      const hit = topmostShapeAt(edit.shapes, point, HIT_SLOP / view.scale, boxOf)
      setSelectedId(hit?.id ?? null)
      if (hit) setGesture({ kind: "move", start: point, original: hit, shape: hit })
      return
    }
    if (tool === "marker") {
      apply({ type: "add", shape: { id: crypto.randomUUID(), kind: "marker", at: point, color } })
      return
    }
    if (isDrawingTool(tool)) setGesture(startDrawing(tool, crypto.randomUUID(), color, point))
  }

  const cursorAt = (point: Point, current: View) => {
    if (tool === "text") return "text"
    if (tool !== "select") return "crosshair"
    const handleSlop = HANDLE_SLOP / current.scale
    const handle = selected
      ? handleAt(shapeHandles(selected), point, handleSlop)
      : handleAt(rectHandles(visible), point, handleSlop)
    if (handle) return cursorFor(handle)
    return topmostShapeAt(edit.shapes, point, HIT_SLOP / current.scale, boxOf) ? "move" : "default"
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!view) return
    const point = pointAt(event, view)
    if (gesture.kind === "idle") {
      const next = cursorAt(point, view)
      if (next !== hoverCursor) setHoverCursor(next)
      return
    }
    setGesture(dragTo(gesture, point, { shift: event.shiftKey, image, penStep: 1 / view.scale }))
  }

  const onPointerUp = () => {
    if (gesture.kind === "idle" || !view) return
    apply(finish(gesture, image, MIN_SIZE / view.scale))
    setGesture(idle)
  }

  const onClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!view || tool !== "text" || typing || saving) return
    const point = pointAt(event, view)
    const existing = textAt(point, view)
    startTransition(() => {
      if (existing) editText(existing)
      else setTyping({ id: crypto.randomUUID(), existing: false, at: point, text: "", color })
    })
  }

  const onDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!view || tool !== "select") return
    const shape = textAt(pointAt(event, view), view)
    if (shape) editText(shape)
  }

  const gestureCursor =
    gesture.kind === "move"
      ? "grabbing"
      : gesture.kind === "resize" || gesture.kind === "crop"
        ? cursorFor(gesture.handle)
        : gesture.kind === "draw"
          ? "crosshair"
          : hoverCursor

  const typingStyle = (draft: Typing, current: View) => {
    const at = toScreen(current, draft.at)
    const fontSize = 16 * unit * current.scale
    return {
      left: at.x,
      top: at.y,
      fontSize,
      fontFamily: FONT_FAMILY,
      lineHeight: 1.3,
      padding: `${fontSize * 0.25}px ${fontSize * 0.5}px`,
      borderRadius: fontSize,
      color: textPill(draft.color).ink,
      backgroundColor: textPill(draft.color).background,
    }
  }

  return (
    <EditorShell
      title={request.original.name}
      subtitle={`${Math.round(shownCrop.width)} × ${Math.round(shownCrop.height)}`}
      onDismiss={dismiss}
      onKeyDown={onKeyDown}
      actions={
        <>
          {error !== null && (
            <p role="alert" className="max-w-sm truncate text-xs text-red-300" title={error}>
              {error}
            </p>
          )}
          <CancelButton onClick={cancel} />
          <Button onClick={done} disabled={saving} aria-busy={saving || undefined} className="gap-2">
            {saving && <SpinnerIcon aria-hidden className="size-3.5 animate-spin" />}
            {m.image_editor_done()}
            <Kbd className="bg-primary-foreground/15 text-primary-foreground">{formatForDisplay("Enter")}</Kbd>
          </Button>
        </>
      }
    >
      <div ref={observeStage} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          style={{ cursor: gestureCursor }}
          className="absolute inset-0 size-full touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setGesture(idle)}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={(event) => event.preventDefault()}
        >
          {m.image_editor_canvas({ name: request.original.name })}
        </canvas>
        {typing && view && (
          <textarea
            ref={(node) => {
              textRef.current = node
              node?.focus()
            }}
            rows={1}
            aria-label={m.image_editor_text_label()}
            value={typing.text}
            onChange={(event) => setTyping({ ...typing, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                returnFocusToEditor(event.currentTarget)
              }
            }}
            onBlur={() => {
              commitTyping()
              setTool("select")
            }}
            style={typingStyle(typing, view)}
            className="absolute field-sizing-content min-w-8 resize-none overflow-hidden font-semibold whitespace-pre shadow-lg outline-2 outline-white/70"
          />
        )}
      </div>
      <div className="flex h-18 shrink-0 items-start justify-center">
        <EditorToolbar
          tool={tool}
          color={color}
          canUndo={canUndo(log)}
          canRedo={canRedo(log)}
          onTool={(next) => startTransition(() => pickTool(next))}
          onColor={(next) => startTransition(() => pickColor(next))}
          onUndo={() => startTransition(() => setLog(undo))}
          onRedo={() => startTransition(() => setLog(redo))}
        />
      </div>
    </EditorShell>
  )
}
