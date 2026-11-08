import { skillIconShape, slashIconShape } from "@hinacode/icons"
import { describe, expect, it } from "vitest"
import { iconPaths } from "./iconPaths.ts"

describe("iconPaths", () => {
  it("reads the skill glyph's filled cap and stroked box", () => {
    expect(iconPaths(skillIconShape)).toEqual([
      { d: "M4.5 7.5 11 2l8.5 2.5L13 10Z", fill: true },
      { d: "M4 11v6l8 4 8-4v-6M4 11l8 4 8-4M12 15v6", fill: false },
    ])
  })

  it("turns the slash glyph's rounded rect into a path with circle-arc corners", () => {
    expect(iconPaths(slashIconShape)).toEqual([
      { d: "M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3z", fill: false },
      { d: "M14.5 7.5l-5 9", fill: false },
    ])
  })
})
