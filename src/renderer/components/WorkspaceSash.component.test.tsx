import { expect, test } from "vitest"
import { cdp, page } from "vitest/browser"
import { render } from "vitest-browser-react"
import "../index.css"
import { SIDE_PANEL_BOUNDS, SIDEBAR_BOUNDS } from "../lib/panelSize.ts"
import { useUi } from "../stores/ui.ts"
import { WorkspaceSash } from "./WorkspaceSash.tsx"

function Workspace() {
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const sidebarWidth = useUi((state) => state.sidebarWidth)
  const sidePanelOpen = useUi((state) => state.sidePanelOpen)
  const sidePanelWidth = useUi((state) => state.sidePanelWidth)
  return (
    <div className="flex h-40 w-[1000px]">
      <nav
        hidden={!sidebarOpen}
        data-workspace-pane="sidebar"
        style={{ width: sidebarWidth, minWidth: SIDEBAR_BOUNDS.min, maxWidth: SIDEBAR_BOUNDS.max }}
        className="relative shrink-0"
      >
        {sidebarOpen && (
          <WorkspaceSash
            label="Resize sidebar"
            pane="sidebar"
            edge="right"
            bounds={SIDEBAR_BOUNDS}
            width={sidebarWidth}
            onReset={() => {}}
          />
        )}
      </nav>
      <div data-workspace-pane="content" style={{ minWidth: 250 }} className="flex-1" />
      {sidePanelOpen && (
        <section
          data-workspace-pane="side-panel"
          style={{ width: sidePanelWidth ?? 300, minWidth: SIDE_PANEL_BOUNDS.min }}
          className="relative"
        >
          <WorkspaceSash
            label="Resize side panel"
            pane="side-panel"
            edge="left"
            bounds={SIDE_PANEL_BOUNDS}
            width={sidePanelWidth}
            onReset={() => {}}
          />
        </section>
      )}
    </div>
  )
}

const mouse = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) =>
  cdp().send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1 })

async function renderWorkspace() {
  useUi.setState({ sidebarOpen: true, sidebarWidth: 300, sidePanelOpen: true, sidePanelWidth: 300 })
  await page.viewport(1200, 400)
  await render(<Workspace />)
  const sash = page.getByRole("separator", { name: "Resize side panel" }).element().getBoundingClientRect()
  return { x: sash.left + sash.width / 2, y: sash.top + sash.height / 2 }
}

const layout = () => {
  const { sidebarOpen, sidebarWidth, sidePanelOpen, sidePanelWidth } = useUi.getState()
  return { sidebarOpen, sidebarWidth, sidePanelOpen, sidePanelWidth }
}

test("dragging the side panel pushes the sidebar closed and brings it back in the same drag", async () => {
  const { x, y } = await renderWorkspace()

  await mouse("mousePressed", x, y)
  await mouse("mouseMoved", x - 200, y)
  await expect.poll(layout).toMatchObject({ sidebarOpen: true, sidebarWidth: 250, sidePanelWidth: 500 })
  await mouse("mouseMoved", x - 400, y)
  await expect.poll(layout).toMatchObject({ sidebarOpen: false, sidebarWidth: 300, sidePanelWidth: 700 })
  await mouse("mouseMoved", x - 100, y)
  await expect.poll(layout).toMatchObject({ sidebarOpen: true, sidebarWidth: 300, sidePanelWidth: 400 })
  await mouse("mouseReleased", x - 100, y)

  expect(layout()).toEqual({ sidebarOpen: true, sidebarWidth: 300, sidePanelOpen: true, sidePanelWidth: 400 })
  expect(document.body.lastElementChild?.matches("[style*=col-resize]")).toBe(false)
})

test("dragging the side panel past half its minimum snaps it closed and keeps its width", async () => {
  const { x, y } = await renderWorkspace()

  await mouse("mousePressed", x, y)
  await mouse("mouseMoved", x + 200, y)
  await mouse("mouseReleased", x + 200, y)

  await expect.poll(layout).toMatchObject({ sidePanelOpen: false, sidePanelWidth: 300 })
})
