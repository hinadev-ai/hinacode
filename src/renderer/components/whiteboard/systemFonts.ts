import { FONT_FAMILY } from "@excalidraw/excalidraw"

export const WHITEBOARD_FONT = FONT_FAMILY.Helvetica

const BUNDLED_FAMILIES = new Set([...Object.keys(FONT_FAMILY), "Xiaolai", "Segoe UI Emoji"])

const isBundled = (family: string) => BUNDLED_FAMILIES.has(family.replaceAll('"', ""))

// FIXME: Excalidraw has no option to skip its bundled fonts. It creates a FontFace for each of its 230 files when a board opens, and Chromium downloads a FontFace's URL as soon as it exists.
window.FontFace = class extends FontFace {
  constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
    super(family, isBundled(family) ? new ArrayBuffer(0) : source, descriptors)
  }
}

const addFontFace = document.fonts.add.bind(document.fonts)

document.fonts.add = (face) => (isBundled(face.family) ? document.fonts : addFontFace(face))
