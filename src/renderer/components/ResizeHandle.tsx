import { cn } from "cn"
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react"
import { clampSize, type SizeBounds } from "../lib/panelSize.ts"

const KEYBOARD_STEP = 16

interface ResizeHandleProps {
  readonly label: string
  /** The edge of `targetRef` the handle sits on. Moving away from the target makes it wider. */
  readonly edge: "left" | "right"
  readonly targetRef: RefObject<HTMLElement | null>
  readonly bounds: SizeBounds
  /** Receives the final width of a drag or key press. */
  readonly onResize: (width: number) => void
  readonly onReset: () => void
}

/** A focusable splitter on one edge of `targetRef`. Drag it, use the arrow keys, or double-click to reset. */
export function ResizeHandle({ label, edge, targetRef, bounds, onResize, onReset }: ResizeHandleProps) {
  const [width, setWidth] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null)
  const grow = edge === "right" ? 1 : -1

  // Measured rather than passed in, so the value stays true while a CSS default or max-width decides the width.
  useEffect(() => {
    const element = targetRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(Math.round(element.getBoundingClientRect().width)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [targetRef])

  // A captured pointer can outlive the handle when a panel hides or becomes an overlay.
  useEffect(
    () => () => {
      if (!drag.current) return
      drag.current = null
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      const element = targetRef.current
      if (element) element.style.transition = ""
    },
    [targetRef],
  )

  const endDrag = () => {
    const current = drag.current
    if (!current) return
    drag.current = null
    setDragging(false)
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    const element = targetRef.current
    if (element) element.style.transition = ""
    onResize(current.width)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = targetRef.current
    if (event.button !== 0 || !element) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startWidth = element.getBoundingClientRect().width
    drag.current = { startX: event.clientX, startWidth, width: startWidth }
    setDragging(true)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    element.style.transition = "none"
  }

  // Writes straight to the DOM so a drag doesn't re-render the panel on every move.
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    const element = targetRef.current
    if (!current || !element) return
    current.width = clampSize(bounds, current.startWidth + grow * (event.clientX - current.startX))
    element.style.width = `${current.width}px`
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    onPointerMove(event)
    endDrag()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = targetRef.current
    if (!element) return
    const currentWidth = element.getBoundingClientRect().width
    const next = {
      ArrowLeft: currentWidth - grow * KEYBOARD_STEP,
      ArrowRight: currentWidth + grow * KEYBOARD_STEP,
      Home: bounds.min,
      End: bounds.max,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    const resized = clampSize(bounds, next)
    // Keyboard input is direct manipulation too. Finish this step before measuring the next one.
    const transition = element.style.transition
    element.style.transition = "none"
    element.style.width = `${resized}px`
    element.getBoundingClientRect()
    element.style.transition = transition
    onResize(resized)
  }

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a focusable splitter is a widget, and <hr> is void so it can't hold the hover line
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={cn(
        "group absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-none",
        edge === "right" ? "-right-1" : "-left-1",
      )}
    >
      <div
        aria-hidden
        className="mx-auto h-full w-0.5 bg-sidebar-ring opacity-0 transition-opacity duration-100 ease-(--ease-out) group-hover:opacity-100 group-focus-visible:opacity-100 group-data-dragging:opacity-100 motion-reduce:transition-none"
      />
    </div>
  )
}
