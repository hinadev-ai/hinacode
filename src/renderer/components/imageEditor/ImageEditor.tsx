import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { SpinnerIcon } from "@hinacode/icons"
import { formatForDisplay } from "@tanstack/react-hotkeys"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  startTransition,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react"
import { AGENT_IMAGE_MAX_BYTES } from "../../../shared/agentImages.ts"
import { cursorFor, cursorForGesture, dimOutside, drawCropFrame, drawSelection } from "../../lib/imageEdit/chrome.ts"
import {
  canRedo,
  canUndo,
  type Color,
  type Command,
  type EditDocument,
  imageBounds,
  PALETTE,
  type Point,
  type Rect,
  push,
  redo,
  replay,
  type Shape,
  undo,
  visibleRect,
} from "../../lib/imageEdit/document.ts"
import { exportDocument } from "../../lib/imageEdit/export.ts"
import { type KeyAction, keyAction } from "../../lib/imageEdit/keys.ts"
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
  pressInSelect,
  previewDocument,
  type Size,
  startDrawing,
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

const typingCommand = (draft: Typing, shapes: ReadonlyArray<Shape>): Command | null => {
  const text = draft.text.trimEnd()
  const shape: Shape = { id: draft.id, kind: "text", at: draft.at, text, color: draft.color }
  if (!draft.existing) return text.trim() === "" ? null : { type: "add", shape }
  if (text.trim() === "") return { type: "remove", id: draft.id }
  const before = shapes.find((each) => each.id === draft.id)
  return before?.kind === "text" && before.text === text && before.color === draft.color
    ? null
    : { type: "update", shape }
}

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

function EditorActions({
  error,
  saving,
  onCancel,
  onDone,
}: {
  error: string | null
  saving: boolean
  onCancel: () => void
  onDone: () => void
}) {
  return (
    <>
      {error !== null && (
        <p role="alert" className="max-w-sm truncate text-xs text-red-300" title={error}>
          {error}
        </p>
      )}
      <CancelButton onClick={onCancel} />
      <Button onClick={onDone} disabled={saving} aria-busy={saving || undefined} className="gap-2">
        {saving && <SpinnerIcon aria-hidden className="size-3.5 animate-spin" />}
        {m.image_editor_done()}
        <Kbd className="bg-primary-foreground/15 text-primary-foreground">{formatForDisplay("Enter")}</Kbd>
      </Button>
    </>
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
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState<Size | null>(null)
  useEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [size, setElement] as const
}

interface Scene {
  readonly stage: Size | null
  readonly view: View | null
  readonly source: EditSource
  readonly preview: EditDocument
  readonly crop: Rect
  readonly selectionBox: Rect | null
  readonly selectionHandles: ReturnType<typeof shapeHandles>
  readonly showCropFrame: boolean
}

function usePaintedCanvas({
  stage,
  view,
  source,
  preview,
  crop,
  selectionBox,
  selectionHandles,
  showCropFrame,
}: Scene) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
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
    drawDocument(ctx, source, preview, crop)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    dimOutside(ctx, view, imageBounds(source.width, source.height), crop)
    if (selectionBox) drawSelection(ctx, view, selectionBox, selectionHandles)
    else if (showCropFrame) drawCropFrame(ctx, view, crop)
  }, [stage, view, source, preview, crop, selectionBox, selectionHandles, showCropFrame])
  return canvasRef
}

function TextDraft({
  draft,
  view,
  unit,
  onChange,
  onCommit,
  inputRef,
}: {
  draft: Typing
  view: View
  unit: number
  onChange: (text: string) => void
  onCommit: () => void
  inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  const at = toScreen(view, draft.at)
  const fontSize = 16 * unit * view.scale
  const pill = textPill(draft.color)
  return (
    <textarea
      ref={(node) => {
        inputRef.current = node
        node?.focus()
      }}
      rows={1}
      aria-label={m.image_editor_text_label()}
      value={draft.text}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault()
          returnFocusToEditor(event.currentTarget)
        }
      }}
      onBlur={onCommit}
      style={{
        left: at.x,
        top: at.y,
        fontSize,
        fontFamily: FONT_FAMILY,
        lineHeight: 1.3,
        padding: `${fontSize * 0.25}px ${fontSize * 0.5}px`,
        borderRadius: fontSize,
        color: pill.ink,
        backgroundColor: pill.background,
      }}
      className="absolute field-sizing-content min-w-8 resize-none overflow-hidden font-semibold whitespace-pre shadow-lg outline-2 outline-white/70"
    />
  )
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
  const canvasRef = usePaintedCanvas({
    stage,
    view,
    source,
    preview,
    crop: shownCrop,
    selectionBox: selected ? shapeBounds(selected, boxOf) : null,
    selectionHandles: selected && gesture.kind === "idle" ? shapeHandles(selected) : NO_HANDLES,
    showCropFrame: tool === "select" && !selected && typing === null,
  })

  const apply = (command: Command | null) => {
    if (command) setLog((current) => push(current, command))
  }

  const commitTyping = () => {
    if (!typing) return log
    const command = typingCommand(typing, edit.shapes)
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

  const runKey = (action: KeyAction) => {
    switch (action.type) {
      case "undo":
        return setLog(undo)
      case "redo":
        return setLog(redo)
      case "done":
        return done()
      case "delete":
        return removeSelected()
      case "nudge":
        return selected && apply({ type: "update", shape: translate(selected, action.dx, action.dy) })
      case "color":
        return pickColor(action.color)
      case "tool":
        return pickTool(action.tool)
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isTextField(event.target)) return
    const action = keyAction(event)
    if (!action) return
    if (action.type === "done" && event.target instanceof HTMLButtonElement) return
    if (action.type !== "tool" && action.type !== "color") event.preventDefault()
    runKey(action)
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
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === "select") {
      const press = pressInSelect({
        point,
        view,
        selected,
        crop: visible,
        shapes: edit.shapes,
        boxOf,
        handleSlop: HANDLE_SLOP / view.scale,
        hitSlop: HIT_SLOP / view.scale,
      })
      setSelectedId(press.selectedId)
      setGesture(press.gesture)
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

  const placeText = (point: Point, current: View) => {
    const existing = textAt(point, current)
    if (existing) editText(existing)
    else setTyping({ id: crypto.randomUUID(), existing: false, at: point, text: "", color })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!view || event.button !== 0) return
    if (tool === "text" && !typing && !saving) placeText(pointAt(event, view), view)
    if (gesture.kind === "idle") return
    apply(finish(gesture, image, MIN_SIZE / view.scale))
    setGesture(idle)
  }

  const onDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!view || tool !== "select") return
    const shape = textAt(pointAt(event, view), view)
    if (shape) editText(shape)
  }

  return (
    <EditorShell
      title={request.original.name}
      subtitle={`${Math.round(shownCrop.width)} × ${Math.round(shownCrop.height)}`}
      onDismiss={dismiss}
      onKeyDown={onKeyDown}
      actions={<EditorActions error={error} saving={saving} onCancel={cancel} onDone={done} />}
    >
      <div ref={observeStage} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          style={{ cursor: cursorForGesture(gesture, hoverCursor) }}
          className="absolute inset-0 size-full touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setGesture(idle)}
          onDoubleClick={onDoubleClick}
          onContextMenu={(event) => event.preventDefault()}
        >
          {m.image_editor_canvas({ name: request.original.name })}
        </canvas>
        {typing && view && (
          <TextDraft
            draft={typing}
            view={view}
            unit={unit}
            inputRef={textRef}
            onChange={(text) => setTyping({ ...typing, text })}
            onCommit={() =>
              startTransition(() => {
                commitTyping()
                setTool("select")
              })
            }
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
