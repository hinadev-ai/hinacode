import { TrashIcon } from "@hinacode/icons"
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react"
import { RiArrowRightUpLine, RiCircleLine, RiRectangleLine, RiShapeLine, RiText } from "react-icons/ri"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import {
  arrowBounds,
  arrowGeometry,
  boundsOf,
  byIdOf,
  centerOf,
  centerOn,
  charactersPerLine,
  contentBounds,
  DEFAULT_SHAPE_HEIGHT,
  DEFAULT_SHAPE_WIDTH,
  elementsInBounds,
  fitView,
  flattenBounds,
  hitTest,
  isArrow,
  LABEL_FONT_SIZE,
  LABEL_LINE_HEIGHT,
  labelTextOf,
  moveElements,
  nextVersion,
  resizeElements,
  TEXT_FONT_SIZE,
  toScreen,
  unionBounds,
  bumpChanged,
  tombstone,
  wrapText,
  zoomAt,
  type Bounds,
  type OwnElement,
  type Point,
  type ToolType,
} from "./own/elements.ts"

export type Tool = "select" | ToolType
type ViewTransform = { readonly x: number; readonly y: number; readonly zoom: number }

type Drag =
  | { readonly kind: "pan"; readonly startScreen: Point; readonly origin: ViewTransform }
  | { readonly kind: "marquee"; readonly start: Point; readonly additive: boolean }
  | {
      readonly kind: "move"
      readonly ids: ReadonlyArray<string>
      readonly start: Point
      readonly snapshot: ReadonlyArray<OwnElement>
    }
  | {
      readonly kind: "resize"
      readonly handle: string
      readonly ids: ReadonlyArray<string>
      readonly original: Bounds
      readonly snapshot: ReadonlyArray<OwnElement>
    }
  | { readonly kind: "draw"; readonly tool: ToolType; readonly start: Point }

type Overlay =
  | { readonly kind: "marquee"; readonly rect: Bounds }
  | {
      readonly kind: "draw"
      readonly bounds: Bounds
      readonly from: Point
      readonly to: Point
      readonly tool: ToolType
    }

type Editing = { readonly id: string; readonly kind: "text" | "label"; readonly value: string }

export type FocusRequest = { readonly ids: ReadonlyArray<string>; readonly nonce: number }

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const

const newId = () => `e${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`

const shapeStyle: CSSProperties = {
  fill: "color-mix(in oklab, var(--muted) 55%, transparent)",
  stroke: "var(--foreground)",
}
const arrowLineStyle: CSSProperties = { fill: "none", stroke: "var(--muted-foreground)" }
const arrowFillStyle: CSSProperties = { fill: "var(--muted-foreground)" }
const textStyle: CSSProperties = { fill: "var(--foreground)" }
const mutedTextStyle: CSSProperties = { fill: "var(--muted-foreground)" }
const selectionStyle: CSSProperties = { fill: "none", stroke: "var(--primary)" }
const handleStyle: CSSProperties = { fill: "var(--background)", stroke: "var(--primary)" }
const marqueeStyle: CSSProperties = {
  fill: "color-mix(in oklab, var(--primary) 12%, transparent)",
  stroke: "var(--primary)",
}
const draftStyle: CSSProperties = {
  fill: "color-mix(in oklab, var(--primary) 10%, transparent)",
  stroke: "var(--primary)",
}

const ARROWS: Record<string, Point> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
}

const focusTextarea = (element: HTMLTextAreaElement | null) => element?.focus()

const handlePoint = (bounds: Bounds, handle: string): Point => {
  const left = bounds.x
  const right = bounds.x + bounds.width
  const top = bounds.y
  const bottom = bounds.y + bounds.height
  const x = handle.includes("w") ? left : handle.includes("e") ? right : (left + right) / 2
  const y = handle.includes("n") ? top : handle.includes("s") ? bottom : (top + bottom) / 2
  return { x, y }
}

const resized = (original: Bounds, handle: string, point: Point): Bounds => {
  let left = original.x
  let right = original.x + original.width
  let top = original.y
  let bottom = original.y + original.height
  if (handle.includes("w")) left = Math.min(point.x, right - 8)
  if (handle.includes("e")) right = Math.max(point.x, left + 8)
  if (handle.includes("n")) top = Math.min(point.y, bottom - 8)
  if (handle.includes("s")) bottom = Math.max(point.y, top + 8)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

const textLines = (element: OwnElement, width: number, fontSize: number) =>
  wrapText(labelTextOf(element), charactersPerLine(width, fontSize))

const arrowHeadPath = (x1: number, y1: number, x2: number, y2: number) => {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const size = 12
  const wing = Math.PI / 7
  const ax = x2 - size * Math.cos(angle - wing)
  const ay = y2 - size * Math.sin(angle - wing)
  const bx = x2 - size * Math.cos(angle + wing)
  const by = y2 - size * Math.sin(angle + wing)
  return `M ${x2} ${y2} L ${ax} ${ay} L ${bx} ${by} Z`
}

const shapeMarkup = (element: OwnElement, bounds: Bounds) => {
  if (element.type === "ellipse") {
    return (
      <ellipse
        cx={bounds.x + bounds.width / 2}
        cy={bounds.y + bounds.height / 2}
        rx={bounds.width / 2}
        ry={bounds.height / 2}
        style={shapeStyle}
        strokeWidth={2}
      />
    )
  }
  if (element.type === "diamond") {
    const center = centerOf(bounds)
    const points = [
      `${center.x},${bounds.y}`,
      `${bounds.x + bounds.width},${center.y}`,
      `${center.x},${bounds.y + bounds.height}`,
      `${bounds.x},${center.y}`,
    ].join(" ")
    return <polygon points={points} style={shapeStyle} strokeWidth={2} />
  }
  return (
    <rect
      x={bounds.x}
      y={bounds.y}
      width={bounds.width}
      height={bounds.height}
      rx={6}
      style={shapeStyle}
      strokeWidth={2}
    />
  )
}

export function OwnCanvas({
  elements,
  selection,
  tool,
  onToolChange,
  onChange,
  onSelectionChange,
  focus,
}: {
  readonly elements: ReadonlyArray<OwnElement>
  readonly selection: ReadonlyArray<string>
  readonly tool: Tool
  readonly onToolChange: (tool: Tool) => void
  readonly onChange: (elements: OwnElement[]) => void
  readonly onSelectionChange: (ids: string[]) => void
  readonly focus: FocusRequest | null
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const space = useRef(false)
  const fitted = useRef(false)
  const focusHandled = useRef(0)
  const firstElements = useRef(elements)
  const [view, setView] = useState<ViewTransform>({ x: 0, y: 0, zoom: 1 })
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)

  const byId = byIdOf(elements)
  const change = (next: OwnElement[]) => onChange(bumpChanged(elements, next))
  const selected = new Set(selection)

  useEffect(() => {
    const svg = rootRef.current
    if (svg === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      setView((current) => zoomAt(current, point, Math.exp(-event.deltaY * 0.0015)))
    }
    svg.addEventListener("wheel", onWheel, { passive: false })
    return () => svg.removeEventListener("wheel", onWheel)
  }, [])

  useEffect(() => {
    const svg = rootRef.current
    if (svg === null) return
    const observer = new ResizeObserver(() => {
      if (fitted.current) return
      const rect = svg.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      fitted.current = true
      setView(fitView({ width: rect.width, height: rect.height }, contentBounds(firstElements.current)))
    })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (focus === null) return
    const svg = rootRef.current
    if (svg === null) return
    const observer = new ResizeObserver(() => {
      if (focusHandled.current === focus.nonce) return
      const rect = svg.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      focusHandled.current = focus.nonce
      onSelectionChange([...focus.ids])
      const bounds = unionBounds(
        focus.ids.flatMap((id) => {
          const element = byIdOf(elements).get(id)
          return element === undefined ? [] : [boundsOf(element)]
        }),
      )
      if (bounds !== null)
        setView((current) =>
          centerOn({ width: rect.width, height: rect.height }, { zoom: Math.max(current.zoom, 0.6) }, bounds),
        )
    })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [focus, elements, onSelectionChange])

  const screenPoint = (event: { readonly clientX: number; readonly clientY: number }): Point => {
    const rect = rootRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const worldPoint = (event: { readonly clientX: number; readonly clientY: number }): Point => {
    const screen = screenPoint(event)
    return { x: (screen.x - view.x) / view.zoom, y: (screen.y - view.y) / view.zoom }
  }

  const capture = (pointerId: number) => {
    const root = rootRef.current
    if (root === null) return
    try {
      root.setPointerCapture(pointerId)
    } catch {
      return
    }
  }

  const startResize = (event: ReactPointerEvent, handle: string) => {
    event.stopPropagation()
    const ids = [...selection]
    const boxes = ids.flatMap((id) => {
      const element = byId.get(id)
      return element === undefined ? [] : [boundsOf(element)]
    })
    const original = unionBounds(boxes)
    if (original === null) return
    capture(event.pointerId)
    drag.current = { kind: "resize", handle, ids, original, snapshot: elements }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (editing !== null) return
    if (event.button !== 0 && event.button !== 1) return
    const screen = screenPoint(event)
    const world = worldPoint(event)
    if (event.button === 1 || space.current) {
      capture(event.pointerId)
      drag.current = { kind: "pan", startScreen: screen, origin: view }
      return
    }
    if (tool !== "select") {
      capture(event.pointerId)
      drag.current = { kind: "draw", tool, start: world }
      setOverlay({ kind: "draw", tool, bounds: flattenBounds(world, world), from: world, to: world })
      return
    }
    const hit = hitTest(elements, world, byId)
    if (hit === undefined) {
      if (!event.shiftKey) onSelectionChange([])
      capture(event.pointerId)
      drag.current = { kind: "marquee", start: world, additive: event.shiftKey }
      setOverlay({ kind: "marquee", rect: flattenBounds(world, world) })
      return
    }
    const next = event.shiftKey
      ? selected.has(hit.id)
        ? [...selection].filter((id) => id !== hit.id)
        : [...selection, hit.id]
      : selected.has(hit.id)
        ? [...selection]
        : [hit.id]
    onSelectionChange(next)
    capture(event.pointerId)
    drag.current = { kind: "move", ids: next, start: world, snapshot: elements }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current === null) return
    const screen = screenPoint(event)
    const world = worldPoint(event)
    switch (current.kind) {
      case "pan":
        setView({
          zoom: current.origin.zoom,
          x: current.origin.x + (screen.x - current.startScreen.x),
          y: current.origin.y + (screen.y - current.startScreen.y),
        })
        return
      case "marquee":
        setOverlay({ kind: "marquee", rect: flattenBounds(current.start, world) })
        return
      case "move":
        change(
          moveElements(current.snapshot, new Set(current.ids), world.x - current.start.x, world.y - current.start.y),
        )
        return
      case "resize":
        change(
          resizeElements(
            current.snapshot,
            new Set(current.ids),
            current.original,
            resized(current.original, current.handle, world),
          ),
        )
        return
      case "draw":
        setOverlay({
          kind: "draw",
          tool: current.tool,
          bounds: flattenBounds(current.start, world),
          from: current.start,
          to: world,
        })
        return
    }
  }

  const commitDraw = (current: Drag & { kind: "draw" }, world: Point) => {
    const bounds = flattenBounds(current.start, world)
    const version = nextVersion(elements)
    if (current.tool === "text") {
      const element: OwnElement = {
        id: newId(),
        type: "text",
        version,
        x: current.start.x,
        y: current.start.y,
        width: Math.max(120, bounds.width),
        height: 24,
        text: "",
      }
      change([...elements, element])
      onSelectionChange([element.id])
      setEditing({ id: element.id, kind: "text", value: "" })
      onToolChange("select")
      return
    }
    if (bounds.width < 6 && bounds.height < 6) return
    if (current.tool === "arrow") {
      const startHit = hitTest(elements, current.start, byId)
      const endHit = hitTest(elements, world, byId)
      const element: OwnElement = {
        id: newId(),
        type: current.tool,
        version,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        ...(startHit === undefined ? {} : { start: { id: startHit.id } }),
        ...(endHit === undefined ? {} : { end: { id: endHit.id } }),
      }
      change([...elements, element])
      onSelectionChange([element.id])
    } else {
      const element: OwnElement = {
        id: newId(),
        type: current.tool,
        version,
        x: bounds.width < 6 ? current.start.x : bounds.x,
        y: bounds.height < 6 ? current.start.y : bounds.y,
        width: bounds.width < 6 ? DEFAULT_SHAPE_WIDTH : bounds.width,
        height: bounds.height < 6 ? DEFAULT_SHAPE_HEIGHT : bounds.height,
      }
      change([...elements, element])
      onSelectionChange([element.id])
    }
    onToolChange("select")
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    drag.current = null
    if (current === null) return
    const world = worldPoint(event)
    switch (current.kind) {
      case "marquee": {
        const rect = flattenBounds(current.start, world)
        const ids = elementsInBounds(elements, rect, byId)
        onSelectionChange(current.additive ? [...new Set([...selection, ...ids])] : ids)
        setOverlay(null)
        return
      }
      case "draw":
        commitDraw(current, world)
        setOverlay(null)
        return
      case "move":
      case "resize":
      case "pan":
        return
    }
  }

  const beginEdit = (element: OwnElement) => {
    if (element.type === "text") setEditing({ id: element.id, kind: "text", value: element.text ?? "" })
    else setEditing({ id: element.id, kind: "label", value: element.label?.text ?? "" })
  }

  const commitEdit = () => {
    const current = editing
    setEditing(null)
    if (current === null) return
    const value = current.value.trim()
    if (current.kind === "text" && value === "") {
      change(tombstone(elements, new Set([current.id])))
      onSelectionChange([])
      return
    }
    change(
      elements.map((element) =>
        element.id !== current.id
          ? element
          : current.kind === "text"
            ? { ...element, text: current.value }
            : { ...element, label: value === "" ? undefined : { text: current.value } },
      ),
    )
  }

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (tool !== "select") return
    const hit = hitTest(elements, worldPoint(event), byId)
    if (hit !== undefined) beginEdit(hit)
  }

  const onGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const active = document.activeElement
    if (
      active instanceof HTMLElement &&
      (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable)
    )
      return
    if (event.key === " ") space.current = true
    if (event.key === "Escape") {
      onSelectionChange([])
      onToolChange("select")
      return
    }
    const nudge = ARROWS[event.key]
    if (nudge !== undefined && selection.length > 0) {
      event.preventDefault()
      const step = event.shiftKey ? 10 : 1
      change(moveElements(elements, new Set(selection), nudge.x * step, nudge.y * step))
      return
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selection.length > 0) {
      event.preventDefault()
      change(tombstone(elements, new Set(selection)))
      onSelectionChange([])
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault()
      onSelectionChange(elements.map((element) => element.id))
    }
  })

  const onGlobalKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === " ") space.current = false
  })

  useEffect(() => {
    window.addEventListener("keydown", onGlobalKeyDown)
    window.addEventListener("keyup", onGlobalKeyUp)
    return () => {
      window.removeEventListener("keydown", onGlobalKeyDown)
      window.removeEventListener("keyup", onGlobalKeyUp)
    }
  }, [])

  const fit = () => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    setView(fitView({ width: rect.width, height: rect.height }, contentBounds(elements)))
  }

  const selectionBounds = unionBounds(
    [...selected].flatMap((id) => {
      const element = byId.get(id)
      if (element === undefined) return []
      return [isArrow(element) ? arrowBounds(element, byId) : boundsOf(element)]
    }),
  )

  const editingElement = editing === null ? undefined : byId.get(editing.id)
  const editingBounds = editingElement === undefined ? null : boundsOf(editingElement)
  const editingScreen =
    editing === null || editingBounds === null ? null : toScreen(view, { x: editingBounds.x, y: editingBounds.y })

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the board is a canvas widget the user draws and selects on.
    <div
      ref={rootRef}
      data-whiteboard
      role="application"
      aria-label={m.whiteboard_canvas_label()}
      className={`relative h-full w-full touch-none overflow-hidden bg-background select-none ${tool === "select" ? "cursor-default" : "cursor-crosshair"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={(event) => event.preventDefault()}
    >
      <svg className="absolute inset-0 h-full w-full">
        <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          {elements
            .filter((element) => isArrow(element) && element.isDeleted !== true)
            .map((element) => {
              const { x1, y1, x2, y2 } = arrowGeometry(element, byId)
              return (
                <g key={element.id} data-element-id={element.id} data-selected={selected.has(element.id) || undefined}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} style={arrowLineStyle} strokeWidth={2} strokeLinecap="round" />
                  {element.type === "arrow" && <path d={arrowHeadPath(x1, y1, x2, y2)} style={arrowFillStyle} />}
                  {element.label === undefined ? null : (
                    <text
                      x={(x1 + x2) / 2}
                      y={(y1 + y2) / 2 - 6}
                      textAnchor="middle"
                      fontSize={LABEL_FONT_SIZE}
                      style={mutedTextStyle}
                    >
                      {element.label.text}
                    </text>
                  )}
                  {selected.has(element.id) && (
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      style={selectionStyle}
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </g>
              )
            })}
          {elements
            .filter((element) => !isArrow(element) && element.type !== "text" && element.isDeleted !== true)
            .map((element) => {
              const bounds = boundsOf(element)
              const label = element.label
              const lines = label === undefined ? [] : textLines(element, bounds.width, LABEL_FONT_SIZE)
              const firstY = bounds.y + bounds.height / 2 - ((lines.length - 1) * LABEL_LINE_HEIGHT) / 2
              return (
                <g key={element.id} data-element-id={element.id} data-selected={selected.has(element.id) || undefined}>
                  {shapeMarkup(element, bounds)}
                  {label !== undefined &&
                    lines.map((line, index) => (
                      <text
                        key={index}
                        x={bounds.x + bounds.width / 2}
                        y={firstY + index * LABEL_LINE_HEIGHT}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={LABEL_FONT_SIZE}
                        style={textStyle}
                      >
                        {line}
                      </text>
                    ))}
                </g>
              )
            })}
          {elements
            .filter((element) => element.type === "text" && element.isDeleted !== true)
            .map((element) => {
              const bounds = boundsOf(element)
              const lines = textLines(element, bounds.width, TEXT_FONT_SIZE)
              return (
                <g key={element.id} data-element-id={element.id} data-selected={selected.has(element.id) || undefined}>
                  {lines.map((line, index) => (
                    <text
                      key={index}
                      x={bounds.x}
                      y={bounds.y + index * (TEXT_FONT_SIZE + 6)}
                      dominantBaseline="hanging"
                      fontSize={TEXT_FONT_SIZE}
                      style={textStyle}
                    >
                      {line}
                    </text>
                  ))}
                  {selected.has(element.id) && (
                    <rect
                      x={bounds.x - 4}
                      y={bounds.y - 4}
                      width={bounds.width + 8}
                      height={Math.max(bounds.height, lines.length * (TEXT_FONT_SIZE + 6)) + 8}
                      rx={4}
                      style={selectionStyle}
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </g>
              )
            })}
          {selectionBounds !== null && (
            <g>
              <rect
                x={selectionBounds.x - 6}
                y={selectionBounds.y - 6}
                width={selectionBounds.width + 12}
                height={selectionBounds.height + 12}
                rx={6}
                style={selectionStyle}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
              {HANDLES.map((handle) => {
                const point = handlePoint(selectionBounds, handle)
                const size = 4 / view.zoom
                return (
                  <rect
                    key={handle}
                    data-handle={handle}
                    x={point.x - size}
                    y={point.y - size}
                    width={size * 2}
                    height={size * 2}
                    rx={1}
                    style={handleStyle}
                    onPointerDown={(event) => startResize(event, handle)}
                  />
                )
              })}
            </g>
          )}
          {overlay !== null && overlay.kind === "marquee" && (
            <rect
              x={overlay.rect.x}
              y={overlay.rect.y}
              width={overlay.rect.width}
              height={overlay.rect.height}
              style={marqueeStyle}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {overlay !== null &&
            overlay.kind === "draw" &&
            overlay.tool !== "text" &&
            (overlay.tool === "arrow" ? (
              <line
                x1={overlay.from.x}
                y1={overlay.from.y}
                x2={overlay.to.x}
                y2={overlay.to.y}
                style={draftStyle}
                strokeWidth={2}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <rect
                x={overlay.bounds.x}
                y={overlay.bounds.y}
                width={overlay.bounds.width}
                height={overlay.bounds.height}
                rx={6}
                style={draftStyle}
                strokeWidth={2}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
              />
            ))}
        </g>
      </svg>
      {editingScreen !== null && editingBounds !== null && editing !== null && (
        <textarea
          ref={focusTextarea}
          value={editing.value}
          onChange={(event) => setEditing({ ...editing, value: event.target.value })}
          onBlur={commitEdit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              commitEdit()
            }
            if (event.key === "Escape") {
              event.preventDefault()
              setEditing(null)
            }
          }}
          style={{
            left: editingScreen.x,
            top: editingScreen.y + (editing.kind === "label" ? (editingBounds.height * view.zoom) / 2 - 12 : 0),
            width: Math.max(120, editingBounds.width * view.zoom),
            fontSize: LABEL_FONT_SIZE * view.zoom,
          }}
          className="absolute min-h-6 resize-none rounded border border-ring bg-background px-1 text-foreground outline-none"
          aria-label={m.whiteboard_edit_label()}
        />
      )}
      <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
        <div
          role="toolbar"
          aria-label={m.whiteboard_tools_label()}
          onPointerDown={(event) => event.stopPropagation()}
          className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border bg-popover/95 p-0.5 shadow-sm backdrop-blur"
        >
          <ToolButton
            active={tool === "select"}
            label={m.whiteboard_tool_select()}
            onClick={() => onToolChange("select")}
          >
            <CursorGlyph />
          </ToolButton>
          <ToolButton
            active={tool === "rectangle"}
            label={m.whiteboard_tool_rectangle()}
            onClick={() => onToolChange("rectangle")}
          >
            <RiRectangleLine aria-hidden />
          </ToolButton>
          <ToolButton
            active={tool === "ellipse"}
            label={m.whiteboard_tool_ellipse()}
            onClick={() => onToolChange("ellipse")}
          >
            <RiCircleLine aria-hidden />
          </ToolButton>
          <ToolButton
            active={tool === "diamond"}
            label={m.whiteboard_tool_diamond()}
            onClick={() => onToolChange("diamond")}
          >
            <RiShapeLine aria-hidden />
          </ToolButton>
          <ToolButton active={tool === "arrow"} label={m.whiteboard_tool_arrow()} onClick={() => onToolChange("arrow")}>
            <RiArrowRightUpLine aria-hidden />
          </ToolButton>
          <ToolButton active={tool === "text"} label={m.whiteboard_tool_text()} onClick={() => onToolChange("text")}>
            <RiText aria-hidden />
          </ToolButton>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <ToolButton
            disabled={selection.length === 0}
            label={m.whiteboard_tool_delete()}
            onClick={() => {
              if (selection.length === 0) return
              change(tombstone(elements, new Set(selection)))
              onSelectionChange([])
            }}
          >
            <TrashIcon aria-hidden />
          </ToolButton>
          <ToolButton label={m.whiteboard_tool_fit()} onClick={fit}>
            <FitGlyph />
          </ToolButton>
        </div>
      </div>
    </div>
  )
}

function ToolButton({
  active,
  disabled,
  label,
  onClick,
  children,
}: {
  readonly active?: boolean
  readonly disabled?: boolean
  readonly label: string
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-pressed={active}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={active ? "bg-muted text-foreground" : "text-muted-foreground"}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

const CursorGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M5 4l14 7-6 2-2 6z" />
  </svg>
)

const FitGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
  </svg>
)
