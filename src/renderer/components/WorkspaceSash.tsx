import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useState } from "react"
import { cn } from "cn"
import type { SizeBounds } from "../lib/panelSize.ts"
import { dragSash, type SplitLayout, type SplitPane } from "../lib/splitView.ts"
import { type UiState, useUi } from "../stores/ui.ts"

const KEYBOARD_STEP = 16
const PANE_IDS = ["sidebar", "content", "side-panel"] as const

export type WorkspacePaneId = (typeof PANE_IDS)[number]
type Edge = "left" | "right"

interface WorkspacePane extends SplitPane {
  readonly id: WorkspacePaneId
}

const isPaneId = (value: string | undefined): value is WorkspacePaneId => PANE_IDS.some((id) => id === value)

const pixels = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function paneBounds(element: HTMLElement): SizeBounds {
  const style = getComputedStyle(element)
  return { min: pixels(style.minWidth, 0), max: pixels(style.maxWidth, Number.POSITIVE_INFINITY) }
}

function readWorkspacePanes(): ReadonlyArray<WorkspacePane> {
  const elements = [...document.querySelectorAll<HTMLElement>("[data-workspace-pane]")].filter((element) =>
    element.checkVisibility(),
  )
  return elements
    .filter((element) => !elements.some((other) => other !== element && element.contains(other)))
    .flatMap((element) => {
      const id = element.dataset.workspacePane
      if (!isPaneId(id)) return []
      return [{ id, size: element.getBoundingClientRect().width, snap: id !== "content", ...paneBounds(element) }]
    })
}

function layoutState(panes: ReadonlyArray<WorkspacePane>, { sizes, visible }: SplitLayout): Partial<UiState> {
  const state: { -readonly [Key in keyof UiState]?: UiState[Key] } = {}
  panes.forEach((pane, index) => {
    const width = Math.round(sizes[index] ?? pane.size)
    const open = visible[index] ?? true
    if (pane.id === "sidebar") Object.assign(state, { sidebarWidth: width, sidebarOpen: open })
    if (pane.id !== "side-panel") return
    state.sidePanelOpen = open
    const keepsDefaultWidth = useUi.getState().sidePanelWidth === null && width === Math.round(pane.size)
    if (!keepsDefaultWidth) state.sidePanelWidth = width
  })
  return state
}

function commitLayout(panes: ReadonlyArray<WorkspacePane>, layout: SplitLayout) {
  const state = layoutState(panes, layout)
  useUi.setState(state)
  const { setSidebarWidth, setSidePanelWidth } = useUi.getState()
  if (state.sidebarWidth !== undefined) setSidebarWidth(state.sidebarWidth)
  if (state.sidePanelWidth != null) setSidePanelWidth(state.sidePanelWidth)
}

const findSash = (panes: ReadonlyArray<WorkspacePane>, pane: WorkspacePaneId, edge: Edge) => {
  const index = panes.findIndex((candidate) => candidate.id === pane)
  const sash = edge === "right" ? index : index - 1
  return index >= 0 && sash >= 0 && sash < panes.length - 1 ? sash : undefined
}

function createDragShield() {
  const shield = document.createElement("div")
  shield.dataset.workspaceShield = ""
  Object.assign(shield.style, { position: "fixed", inset: "0", zIndex: "2147483647", cursor: "col-resize" })
  document.body.append(shield)
  return shield
}

function dragWorkspace(event: ReactPointerEvent<HTMLElement>, pane: WorkspacePaneId, edge: Edge, onEnd: () => void) {
  const panes = readWorkspacePanes()
  const sash = findSash(panes, pane, edge)
  if (sash === undefined) return false
  const { pointerId, clientX: startX } = event
  let target: HTMLElement = event.currentTarget
  let shield: HTMLElement | undefined
  let layout: SplitLayout | undefined
  let frame = 0
  let ended = false
  const { sidebarOpen, sidebarWidth, sidePanelOpen, sidePanelWidth } = useUi.getState()

  const follow = (pointer: PointerEvent) => {
    if (!shield && pointer.clientX === startX) return
    layout = dragSash(panes, sash, pointer.clientX - startX)
  }

  const onMove = (pointer: PointerEvent) => {
    follow(pointer)
    if (!layout) return
    if (!shield) {
      unlisten(target)
      shield = createDragShield()
      target = shield
      listen(target)
      target.setPointerCapture(pointerId)
    }
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (layout) useUi.setState(layoutState(panes, layout))
    })
  }

  const stop = () => {
    if (ended) return false
    ended = true
    cancelAnimationFrame(frame)
    unlisten(target)
    window.removeEventListener("resize", abort)
    shield?.remove()
    onEnd()
    return true
  }

  const end = () => {
    if (stop() && layout) commitLayout(panes, layout)
  }

  const abort = () => {
    if (stop()) useUi.setState({ sidebarOpen, sidebarWidth, sidePanelOpen, sidePanelWidth })
  }

  const onUp = (pointer: PointerEvent) => {
    follow(pointer)
    end()
  }

  function listen(element: HTMLElement) {
    element.addEventListener("pointermove", onMove)
    element.addEventListener("pointerup", onUp)
    element.addEventListener("pointercancel", end)
    element.addEventListener("lostpointercapture", end)
  }

  function unlisten(element: HTMLElement) {
    element.removeEventListener("pointermove", onMove)
    element.removeEventListener("pointerup", onUp)
    element.removeEventListener("pointercancel", end)
    element.removeEventListener("lostpointercapture", end)
  }

  listen(target)
  window.addEventListener("resize", abort)
  target.setPointerCapture(pointerId)
  return true
}

function nudgeWorkspace(pane: WorkspacePaneId, edge: Edge, key: string) {
  const panes = readWorkspacePanes()
  const sash = findSash(panes, pane, edge)
  const own = panes.find((candidate) => candidate.id === pane)
  if (sash === undefined || !own) return false
  const grow = edge === "right" ? 1 : -1
  const delta = {
    ArrowLeft: -KEYBOARD_STEP,
    ArrowRight: KEYBOARD_STEP,
    Home: grow * (own.min - own.size),
    End: grow * (own.max - own.size),
  }[key]
  if (delta === undefined) return false
  commitLayout(panes, dragSash(panes, sash, delta, { snap: false }))
  return true
}

interface WorkspaceSashProps {
  readonly label: string
  readonly pane: Exclude<WorkspacePaneId, "content">
  readonly edge: Edge
  readonly bounds: SizeBounds
  readonly width: number | null
  readonly onReset: () => void
}

export function WorkspaceSash({ label, pane, edge, bounds, width, onReset }: WorkspaceSashProps) {
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    if (dragWorkspace(event, pane, edge, () => setDragging(false))) setDragging(true)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (nudgeWorkspace(pane, edge, event.key)) event.preventDefault()
  }

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a focusable splitter is a widget, and <hr> is void so it can't hold the hover line
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={bounds.min}
      aria-valuemax={Number.isFinite(bounds.max) ? bounds.max : undefined}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={cn(
        "group absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-none",
        edge === "right" ? "-right-1" : "-left-1",
      )}
    >
      <div
        aria-hidden
        className="mx-auto h-full w-0.5 bg-sidebar-ring opacity-0 transition-opacity duration-100 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 group-data-dragging:opacity-100"
      />
    </div>
  )
}
