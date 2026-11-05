import { CALLOUT_TONES } from "@shared/documentCallout.ts"
import { describe, expect, it, vi } from "vitest"
import { CalloutColors, Colors } from "@/constants/theme"

vi.mock("react-native", () => ({ Platform: { select: () => "monospace" } }))

const luminance = (hex: string) => {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
}

const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

describe("callout colors", () => {
  for (const scheme of ["light", "dark"] as const)
    for (const tone of CALLOUT_TONES)
      it(`keeps the ${scheme} ${tone} label and body at AA on its tint`, () => {
        const { label, tint } = CalloutColors[scheme][tone]
        expect(contrast(label, tint)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(Colors[scheme].text, tint)).toBeGreaterThanOrEqual(4.5)
      })
})
