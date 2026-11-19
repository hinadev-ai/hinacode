import { describe, expect, it } from "vitest"
import { dragSash, type SplitPane } from "./splitView.ts"

const sidebar = (size: number): SplitPane => ({ size, min: 200, max: 480, snap: true })
const content = (size: number): SplitPane => ({ size, min: 250, max: Number.POSITIVE_INFINITY, snap: false })
const sidePanel = (size: number): SplitPane => ({ size, min: 280, max: Number.POSITIVE_INFINITY, snap: true })

const workspace = [sidebar(300), content(600), sidePanel(400)]
const sidePanelSash = 1
const sidebarSash = 0

describe("dragSash", () => {
  it("takes space from the pane next to the sash first", () => {
    expect(dragSash(workspace, sidePanelSash, -100)).toEqual({ sizes: [300, 500, 500], visible: [true, true, true] })
  })

  it("pushes the next pane once the neighbour reaches its minimum", () => {
    expect(dragSash(workspace, sidePanelSash, -400).sizes).toEqual([250, 250, 800])
  })

  it("stops at the limit until the drag passes half the snapping pane's minimum", () => {
    expect(dragSash(workspace, sidePanelSash, -540)).toEqual({ sizes: [200, 250, 850], visible: [true, true, true] })
  })

  it("snaps the pushed pane closed and keeps its size for when it returns", () => {
    expect(dragSash(workspace, sidePanelSash, -560)).toEqual({ sizes: [300, 250, 960], visible: [false, true, true] })
  })

  it("brings a snapped pane back when the drag returns", () => {
    expect(dragSash(workspace, sidePanelSash, -549).visible).toEqual([true, true, true])
  })

  it("snaps the pane being shrunk when the drag passes half its minimum", () => {
    expect(dragSash(workspace, sidePanelSash, 200).sizes).toEqual([300, 720, 280])
    expect(dragSash(workspace, sidePanelSash, 260)).toEqual({ sizes: [300, 1000, 400], visible: [true, true, false] })
  })

  it("pushes through the content to the pane on the far side", () => {
    const narrow = [sidebar(300), content(300), sidePanel(400)]
    expect(dragSash(narrow, sidebarSash, 150).sizes).toEqual([450, 250, 300])
    expect(dragSash(narrow, sidebarSash, 320)).toEqual({ sizes: [480, 250, 400], visible: [true, true, false] })
  })

  it("does not snap the far pane when only the dragged pane hit its maximum", () => {
    expect(dragSash(workspace, sidebarSash, 500)).toEqual({ sizes: [480, 420, 400], visible: [true, true, true] })
    expect(dragSash(workspace, sidebarSash, 700)).toEqual({ sizes: [480, 420, 400], visible: [true, true, true] })
  })

  it("clamps instead of snapping when snapping is off", () => {
    expect(dragSash(workspace, sidePanelSash, -10_000, { snap: false })).toEqual({
      sizes: [200, 250, 850],
      visible: [true, true, true],
    })
  })
})
