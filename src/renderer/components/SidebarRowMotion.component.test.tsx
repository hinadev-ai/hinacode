import { expect, test } from "vitest"
import { render } from "vitest-browser-react"
import "../index.css"
import { SidebarRow, SidebarRowPresence } from "./SidebarRowMotion.tsx"

const List = ({ rows }: { rows: ReadonlyArray<string> }) => (
  <ul>
    <SidebarRowPresence placements={rows.map((id) => ({ id, section: "ready" }))} still={false}>
      {rows.map((id) => (
        <SidebarRow key={id} data-testid={id} className="opacity-60">
          {id}
        </SidebarRow>
      ))}
    </SidebarRowPresence>
  </ul>
)

test("a row that arrives keeps the opacity its classes give it", async () => {
  const screen = await render(<List rows={[]} />)
  await screen.rerender(<List rows={["working"]} />)
  const row = screen.getByTestId("working").element()

  await expect.poll(() => getComputedStyle(row).opacity).toBe("0.6")
})
